// Turning a formatted message into WhatsApp sends.
//
// Two host limits shape this file: a media caption is capped at 1024 characters and a text message at
// 4096. The sidecar this plugin replaces never had to care — it handed the text to an agent that made
// its own send calls — so exceeding either limit is a new failure mode, and it is handled by planning
// the sends up front rather than discovering a 400 at delivery time.

import type { ConversationSendEnvelope } from './types/openwa';

export const MAX_CAPTION = 1024;
export const MAX_TEXT = 4096;

/** Delays between send attempts. Two retries, matching the sidecar's backoff. */
export const RETRY_DELAYS_MS = [1000, 2000];

export type SendPart =
  | { kind: 'image'; mediaUrl: string; caption?: string }
  | { kind: 'text'; text: string };

/**
 * Split text into chunks no longer than `limit`, preferring line boundaries so a message never breaks
 * mid-sentence. A single line longer than the limit is hard-split — nothing else can be done with it.
 */
export function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = '';

  for (const line of text.split('\n')) {
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks.filter((c) => c.length > 0);
}

/**
 * Decide the sends for one notification.
 *
 * A poster rides along as the caption when the whole message fits in 1024 characters — one message, the
 * way the sidecar's agent used to send it. When it does not fit, the poster is sent UNCAPTIONED followed
 * by the text, rather than captioning it with a truncated copy of text that is about to be repeated.
 */
export function planSends(text: string, posterUrl: string | null, sendPoster: boolean): SendPart[] {
  const body = text.trimEnd();
  const poster = sendPoster && posterUrl ? posterUrl : null;

  if (poster && body.length <= MAX_CAPTION) {
    return [{ kind: 'image', mediaUrl: poster, caption: body }];
  }

  const parts: SendPart[] = [];
  if (poster) parts.push({ kind: 'image', mediaUrl: poster });
  for (const chunk of splitText(body, MAX_TEXT)) parts.push({ kind: 'text', text: chunk });
  return parts;
}

export function partToEnvelope(part: SendPart, sessionId: string, chatId: string): ConversationSendEnvelope {
  if (part.kind === 'image') {
    return { sessionId, chatId, type: 'image', mediaUrl: part.mediaUrl, text: part.caption };
  }
  // linkPreview is left unset: whatsapp-web.js previews by default and Baileys does not, and forcing a
  // preview on Baileys costs a blocking page fetch per trailer URL before the message can go out.
  return { sessionId, chatId, type: 'text', text: part.text };
}

/**
 * A capability call that exceeded the host's budget. The host does NOT cancel the underlying work when
 * this fires, so the message may still be delivered — retrying it is how one notification becomes two.
 * Every other failure is a genuine non-delivery and is safe to retry.
 */
export function isHostTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out after \d+ms/.test(message);
}

export interface SendDeps {
  send: (env: ConversationSendEnvelope) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  log: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * Send one envelope, retrying transient failures. Resolves true on delivery, false once the attempts are
 * exhausted or the failure is one a retry must not touch.
 */
export async function sendWithRetry(deps: SendDeps, env: ConversationSendEnvelope): Promise<boolean> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await deps.sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      await deps.send(env);
      return true;
    } catch (err) {
      lastError = err;
      if (isHostTimeout(err)) {
        deps.log('seerr-notify: send timed out host-side; not retrying (the message may still arrive)', {
          type: env.type,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    }
  }

  deps.log('seerr-notify: send failed after retries', {
    type: env.type,
    attempts: RETRY_DELAYS_MS.length + 1,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });
  return false;
}
