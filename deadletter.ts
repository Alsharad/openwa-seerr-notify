// A bounded record of notifications that could not be delivered, replacing the sidecar's
// dead-letter.json.
//
// Deliberately ONE storage key holding a capped ring of entries, not a key per failure. The host
// re-measures the plugin's 50 MiB quota with a synchronous readdir + stat of every key on EVERY write,
// so key-per-event turns a burst of failures into an event-loop stall for the whole gateway.
//
// This is a diagnostic buffer, not a queue: nothing redrives from it. A delivery whose ingress dispatch
// FAILED (this handler threw) already has a host-side dead-letter row with a redrive path; entries here
// cover what the host considers delivered — a send that failed in the background, or an event nobody was
// mapped to receive.

import type { PluginStorage } from './types/openwa';

export const DEAD_LETTER_KEY = 'dead-letters';
export const MAX_DEAD_LETTERS = 50;

export type DeadLetterReason = 'invalid_payload' | 'no_recipients' | 'no_session' | 'send_failed';

export interface DeadLetter {
  at: string;
  reason: DeadLetterReason;
  eventType: string | null;
  deliveryId: string;
  detail?: string;
}

export interface DeadLetterDeps {
  storage: Pick<PluginStorage, 'get' | 'set'>;
  log: (message: string, meta?: Record<string, unknown>) => void;
  now?: () => string;
}

/**
 * Append one entry, keeping the newest {@link MAX_DEAD_LETTERS}.
 *
 * Read-modify-write, so two failures recorded concurrently can cost one entry. That is accepted: the
 * alternative is per-entry keys, whose cost is described above, and losing a line from a diagnostic
 * buffer is not worth paying it. Never throws — a failure to record a failure must not escalate.
 */
export async function recordDeadLetter(
  deps: DeadLetterDeps,
  entry: Omit<DeadLetter, 'at'> & { at?: string },
): Promise<void> {
  const at = entry.at ?? (deps.now ?? (() => new Date().toISOString()))();
  const record: DeadLetter = { ...entry, at };

  try {
    const existing = (await deps.storage.get<DeadLetter[]>(DEAD_LETTER_KEY)) ?? [];
    const list = Array.isArray(existing) ? existing : [];
    await deps.storage.set(DEAD_LETTER_KEY, [record, ...list].slice(0, MAX_DEAD_LETTERS));
  } catch (err) {
    // A rejected set is usually the storage quota. Log it loudly — silently dropping the record would
    // leave the operator with no trace of the delivery failure at all.
    deps.log('seerr-notify: could not persist dead letter', {
      reason: record.reason,
      deliveryId: record.deliveryId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function readDeadLetters(deps: Pick<DeadLetterDeps, 'storage'>): Promise<DeadLetter[]> {
  const existing = await deps.storage.get<DeadLetter[]>(DEAD_LETTER_KEY);
  return Array.isArray(existing) ? existing : [];
}
