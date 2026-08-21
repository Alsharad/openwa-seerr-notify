// The Setup tab's "Send a test message" button, on the plugin side.
//
// It exists because Seerr's own Test Notification button can only ever work once. OpenWA dedupes ingress
// on `(pluginId, instanceId, providerDeliveryId)` with a DB UNIQUE constraint, and with no delivery-id
// header from the provider that id is `sha256(pluginId ∥ instanceId ∥ route ∥ rawBody)`. A Seerr test
// payload carries no id and no timestamp and is byte-identical every press, so the second press and
// every one after it is answered `200 duplicate` before this plugin is invoked — while Seerr still
// reports success. There is no setting on either side that changes that: the dedup has no per-route
// opt-out, and Seerr sends no header whose value varies.
//
// So this does not go through ingress at all. It is not a webhook, so there is nothing to dedupe, and it
// can be pressed as often as you like. What it gives up is coverage of the ingress hop itself — the URL
// and the Authorization header — which is exactly what a real Seerr notification proves and what the
// health check reports on. What it keeps is everything after that hop, and it keeps it by running the
// SAME code a real delivery runs rather than a parallel imitation that could drift: session resolution,
// recipient routing, message formatting, and the retrying WhatsApp send.

import { processEvent } from './handler.ts';
import type { HandlerDeps } from './handler.ts';
import { normalizePayload, validatePayload } from './normalize.ts';
import { resolveRecipients } from './recipients.ts';
import { maskChatId } from './config.ts';

/**
 * Byte-for-byte what Seerr's Test button puts on the wire, captured from a live 3.4.1 instance. Keeping
 * it identical is the point: a test that exercised a tidier payload than the real one would not be
 * evidence about the real one.
 */
export const SEERR_TEST_PAYLOAD = {
  notification_type: 'TEST_NOTIFICATION',
  event: '',
  subject: 'Test Notification',
  message: 'Check check, 1, 2, 3. Are we coming in clear?',
  image: '',
  media: null,
  request: null,
  issue: null,
  comment: null,
  extra: [],
};

export interface TestSendDeps {
  handler: HandlerDeps;
  /** Resolved exactly as a real delivery resolves it — see session-resolve.ts. */
  sessionId: string;
  /** Distinguishes this press in the log and in any dead letter it produces. */
  deliveryId: string;
}

export interface TestSendResult {
  ok: boolean;
  message: string;
}

/**
 * Send one test notification through the real pipeline.
 *
 * Recipients are resolved BEFORE dispatching so the button can say who it went to. processEvent resolves
 * them again internally — the duplicate work is one array filter over a handful of configured users, and
 * paying it keeps this from having to reimplement (and then drift from) the routing rules.
 */
export async function sendTestMessage(deps: TestSendDeps): Promise<TestSendResult> {
  const validated = validatePayload(SEERR_TEST_PAYLOAD);
  if (!validated.ok) return { ok: false, message: `the built-in test payload is invalid: ${validated.reason}` };
  const event = normalizePayload(validated.value);

  const recipients = resolveRecipients(deps.handler.config, event);
  if (recipients.length === 0) {
    // Worth naming precisely: a test is routed to admins, so the usual cause is that nobody ticked on the
    // Recipients tab is an admin in Seerr — not that the list is empty.
    return {
      ok: false,
      message:
        'nobody to send a test to — a test notification goes to Seerr admins, so tick at least one ' +
        'admin on the Recipients tab',
    };
  }

  await processEvent(deps.handler, event, {
    instanceId: 'setup-test',
    method: 'POST',
    headers: {},
    query: {},
    body: JSON.stringify(SEERR_TEST_PAYLOAD),
    rawBody: JSON.stringify(SEERR_TEST_PAYLOAD),
    verified: true,
    deliveryId: deps.deliveryId,
    sessionId: deps.sessionId,
  }, deps.sessionId);

  const who = recipients.map((r) => maskChatId(r.chatId)).join(', ');
  return {
    ok: true,
    message: `test message sent to ${recipients.length} recipient(s): ${who}`,
  };
}
