// One Seerr webhook delivery → WhatsApp messages. Pure handler: every host capability arrives through
// `deps`, so the whole flow is unit-testable without a PluginContext.
//
// TIMING IS THE CONSTRAINT HERE. The host dispatches an ingress handler with a 5 s budget
// (INGRESS_DISPATCH_TIMEOUT_MS) and does NOT cancel the work when that expires — it records the
// delivery as failed while the handler keeps running. This notification does up to three Seerr API
// calls and then one poster upload per recipient; the host budgets a SINGLE media send at 120 s, so the
// work cannot fit in 5 s and must not try. The handler therefore validates synchronously and floats the
// rest (`void processEvent(...)`), exactly like supabase-otp-hook's fire-and-forget send.
//
// What that costs: the host's ingress retry + DLQ no longer covers delivery, because the handler has
// already returned successfully by the time anything can fail. Retries are owned here (see deliver.ts)
// and unrecoverable failures are recorded via recordDeadLetter. What it buys: no false "dispatch
// failed" row, and no redrive re-running a handler that already sent — which would deliver the same
// notification twice.

import type { PluginStorage, WebhookRequest } from './types/openwa';
import type { SeerrConfig } from './config.ts';
import { maskChatId } from './config.ts';
import { normalizePayload, validatePayload } from './normalize.ts';
import type { NormalizedEvent } from './normalize.ts';
import { resolveRecipients } from './recipients.ts';
import { formatMessages } from './formatter.ts';
import { routingFor } from './routing.ts';
import { enrich } from './seerr-client.ts';
import type { NetFetch } from './seerr-client.ts';
import { partToEnvelope, planSends, sendWithRetry } from './deliver.ts';
import type { SendDeps } from './deliver.ts';
import { recordDeadLetter } from './deadletter.ts';
import type { DeadLetterDeps } from './deadletter.ts';

/** Event types that carry a poster worth attaching. Elsewhere the image adds nothing. */
const POSTER_TYPES = new Set(['MEDIA_AVAILABLE', 'MEDIA_PENDING']);

export interface HandlerDeps {
  config: SeerrConfig;
  net: NetFetch;
  send: SendDeps['send'];
  storage: Pick<PluginStorage, 'get' | 'set'>;
  log: (message: string, meta?: Record<string, unknown>) => void;
  sleep: (ms: number) => Promise<void>;
  now?: () => string;
}

function debug(deps: HandlerDeps, message: string, meta?: Record<string, unknown>): void {
  if (deps.config.debug) deps.log(message, { debug: true, ...meta });
}

function deadLetterDeps(deps: HandlerDeps): DeadLetterDeps {
  return { storage: deps.storage, log: deps.log, now: deps.now };
}

/**
 * The slow half: enrich, resolve recipients, format, send. Runs detached from the ingress dispatch, so
 * it must swallow its own failures — nothing upstream is still listening.
 */
export async function processEvent(deps: HandlerDeps, event: NormalizedEvent, req: WebhookRequest, sessionId: string): Promise<void> {
  const cfg = deps.config;

  if (cfg.jellyseerr.enabled) {
    await enrich(
      { fetch: deps.net, baseUrl: cfg.jellyseerr.url, apiKey: cfg.jellyseerr.apiKey, log: deps.log },
      event,
    );
  }

  const recipients = resolveRecipients(cfg, event);
  debug(deps, 'seerr-notify: recipients resolved', {
    deliveryId: req.deliveryId,
    eventType: event.notificationType,
    count: recipients.length,
    chatIds: recipients.map((r) => maskChatId(r.chatId)),
  });

  if (recipients.length === 0) {
    if (cfg.requireMappedUser) {
      await recordDeadLetter(deadLetterDeps(deps), {
        reason: 'no_recipients',
        eventType: event.notificationType,
        deliveryId: req.deliveryId,
        detail: 'no configured user matched this event',
      });
      deps.log('seerr-notify: no recipient matched this event', {
        deliveryId: req.deliveryId,
        eventType: event.notificationType,
      });
    }
    return;
  }

  const { userMessage, adminMessage } = formatMessages(
    event,
    cfg.flags,
    routingFor(cfg.routing, event.notificationType).adminInfo,
  );
  const posterUrl = POSTER_TYPES.has(event.notificationType) && event.posterUrl ? event.posterUrl : null;
  const sendDeps: SendDeps = { send: deps.send, sleep: deps.sleep, log: deps.log };

  // Recipients are handled sequentially. A notification fans out to a handful of chats at most, and
  // WhatsApp treats a burst of concurrent sends from one session far less kindly than a short sequence.
  for (const recipient of recipients) {
    const text = recipient.isAdmin ? adminMessage : userMessage;
    const parts = planSends(text, posterUrl, cfg.sendPoster);

    for (const part of parts) {
      const delivered = await sendWithRetry(sendDeps, partToEnvelope(part, sessionId, recipient.chatId));
      if (!delivered) {
        await recordDeadLetter(deadLetterDeps(deps), {
          reason: 'send_failed',
          eventType: event.notificationType,
          deliveryId: req.deliveryId,
          detail: `${part.kind} send to ${maskChatId(recipient.chatId)} failed`,
        });
        // Skip this recipient's remaining parts: a text follow-up to an image that never arrived reads
        // as an orphan. Other recipients are unaffected.
        break;
      }
      debug(deps, 'seerr-notify: part delivered', {
        deliveryId: req.deliveryId,
        chatId: maskChatId(recipient.chatId),
        part: part.kind,
      });
    }
  }
}

/**
 * Ingress entry point. Validates synchronously, then floats the delivery work.
 *
 * The return value is ignored by the host — the provider's reply comes from the manifest's
 * `ingress[].response.ack`. Only throwing matters, and this deliberately does not throw: every failure
 * it can see is permanent (a malformed body, an unmapped user, no session to send from), and a retry of
 * a permanent failure just repeats it.
 */
export async function handleSeerrWebhook(deps: HandlerDeps, req: WebhookRequest): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body);
  } catch {
    await recordDeadLetter(deadLetterDeps(deps), {
      reason: 'invalid_payload',
      eventType: null,
      deliveryId: req.deliveryId,
      detail: 'body is not valid JSON',
    });
    deps.log('seerr-notify: malformed JSON body; not retrying', { deliveryId: req.deliveryId });
    return;
  }

  const validated = validatePayload(parsed);
  if (!validated.ok) {
    await recordDeadLetter(deadLetterDeps(deps), {
      reason: 'invalid_payload',
      eventType: null,
      deliveryId: req.deliveryId,
      detail: validated.reason,
    });
    deps.log('seerr-notify: unusable payload; not retrying', {
      deliveryId: req.deliveryId,
      reason: validated.reason,
    });
    return;
  }

  const event = normalizePayload(validated.value);

  const sessionId = req.sessionId ?? deps.config.fallbackSessionId;
  if (!sessionId) {
    await recordDeadLetter(deadLetterDeps(deps), {
      reason: 'no_session',
      eventType: event.notificationType,
      deliveryId: req.deliveryId,
      detail: 'ingress instance is not bound to a session and no fallbackSessionId is set',
    });
    deps.log('seerr-notify: no session to send from', { deliveryId: req.deliveryId });
    return;
  }

  debug(deps, 'seerr-notify: inbound delivery', {
    deliveryId: req.deliveryId,
    instanceId: req.instanceId,
    eventType: event.notificationType,
    sessionId,
  });

  // Floated on purpose — see the file header. Failures are logged and dead-lettered inside.
  void processEvent(deps, event, req, sessionId).catch((err: unknown) => {
    deps.log('seerr-notify: delivery failed (background)', {
      deliveryId: req.deliveryId,
      eventType: event.notificationType,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
