// Who receives a given event.
//
// Routing mirrors what Seerr itself considers actionable:
//   MEDIA_PENDING / APPROVED / DECLINED / FAILED → the requester and every admin
//   MEDIA_AVAILABLE / AUTO_APPROVED / AUTO_REQUESTED → the requester only (admins do not need the noise)
//   ISSUE_*   → the reporter and every admin
//   TEST_NOTIFICATION → admins only

import type { SeerrConfig, SeerrUser } from './config.ts';
import type { NormalizedEvent, SeerrActor } from './normalize.ts';
import { routingFor } from './routing.ts';

export type RecipientSource = 'requester' | 'reporter' | 'admin';

export interface Recipient {
  chatId: string;
  number: string;
  seerrUserId: number | null;
  isAdmin: boolean;
  source: RecipientSource;
}

/**
 * Match a Seerr actor to a configured user. Identity first (a Seerr user id is stable and unambiguous),
 * then email, then username — the last two are fallbacks for deployments that never enabled enrichment,
 * where the id is unavailable.
 */
export function matchUser(users: SeerrUser[], actor: SeerrActor | undefined): SeerrUser | null {
  if (!actor) return null;
  return (
    users.find((user) => {
      if (actor.userId !== null && user.seerrUserId !== null && String(actor.userId) === String(user.seerrUserId)) {
        return true;
      }
      if (actor.email && user.email && actor.email === user.email) return true;
      if (actor.username && user.username && actor.username === user.username) return true;
      return false;
    }) ?? null
  );
}

function toRecipient(user: SeerrUser, source: RecipientSource): Recipient {
  return {
    chatId: user.chatId,
    number: user.number,
    seerrUserId: user.seerrUserId,
    isAdmin: user.isAdmin,
    source,
  };
}

/** First entry per chat id wins, so a requester who is also an admin keeps the richer admin message. */
function dedupe(recipients: Recipient[]): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const r of recipients) {
    if (!r.chatId || seen.has(r.chatId)) continue;
    seen.add(r.chatId);
    out.push(r);
  }
  return out;
}

/**
 * Who receives this event, per the operator's routing table.
 *
 * An event type with no row — a future Seerr addition — reaches nobody rather than fanning out to every
 * admin by accident (see routingFor).
 */
export function resolveRecipients(config: SeerrConfig, event: NormalizedEvent): Recipient[] {
  const { users } = config;
  const type = event.notificationType;
  const routing = routingFor(config.routing, type);
  const out: Recipient[] = [];

  if (routing.user) {
    // ISSUE_* events name a reporter; every MEDIA_* event names a requester.
    const isIssue = type.startsWith('ISSUE_');
    const actor = matchUser(users, isIssue ? event.reporter : event.requester);
    if (actor) out.push(toRecipient(actor, isIssue ? 'reporter' : 'requester'));
  }

  if (routing.admin) {
    for (const admin of users.filter((u) => u.isAdmin)) out.push(toRecipient(admin, 'admin'));
  }

  return dedupe(out);
}
