// Who receives which Seerr event, as operator-editable config.
//
// The defaults below are the routing this plugin shipped with — the behaviour Seerr itself implies:
// requesters hear about their own requests, admins hear about anything they may need to act on, and
// nobody is copied on the purely informational events. An operator can now flip any cell in the
// "Who gets what" tab; the defaults are what a fresh install (or an unset cell) resolves to.

export interface EventRouting {
  /** Notify the requester (MEDIA_*) or reporter (ISSUE_*) behind the event. */
  user: boolean;
  /** Notify every enabled recipient Seerr marks as an admin. */
  admin: boolean;
  /** Append the Admin Info block to the admins' copy. Ignored where there is nothing to append. */
  adminInfo: boolean;
}

export type RoutingTable = Record<string, EventRouting>;

/** Every event type this plugin routes, in the order the editor lists them. */
export const ROUTED_EVENTS = [
  'MEDIA_PENDING',
  'MEDIA_APPROVED',
  'MEDIA_DECLINED',
  'MEDIA_FAILED',
  'MEDIA_AVAILABLE',
  'MEDIA_AUTO_APPROVED',
  'MEDIA_AUTO_REQUESTED',
  'ISSUE_CREATED',
  'ISSUE_COMMENT',
  'ISSUE_RESOLVED',
  'ISSUE_REOPENED',
  'TEST_NOTIFICATION',
] as const;

const REQUESTER_AND_ADMINS: EventRouting = { user: true, admin: true, adminInfo: true };
const REQUESTER_ONLY: EventRouting = { user: true, admin: false, adminInfo: false };

export const DEFAULT_ROUTING: RoutingTable = {
  MEDIA_PENDING: REQUESTER_AND_ADMINS,
  MEDIA_APPROVED: REQUESTER_AND_ADMINS,
  MEDIA_DECLINED: REQUESTER_AND_ADMINS,
  MEDIA_FAILED: REQUESTER_AND_ADMINS,
  // Informational: the requester wants it, admins already know — they approved it.
  MEDIA_AVAILABLE: REQUESTER_ONLY,
  MEDIA_AUTO_APPROVED: REQUESTER_ONLY,
  MEDIA_AUTO_REQUESTED: REQUESTER_ONLY,
  ISSUE_CREATED: REQUESTER_AND_ADMINS,
  ISSUE_COMMENT: REQUESTER_AND_ADMINS,
  ISSUE_RESOLVED: REQUESTER_AND_ADMINS,
  ISSUE_REOPENED: REQUESTER_AND_ADMINS,
  // A test has no requester to notify, and nothing to put in an Admin Info block.
  TEST_NOTIFICATION: { user: false, admin: true, adminInfo: false },
};

/**
 * Does this event type have anything to put in an Admin Info block?
 *
 * TEST_NOTIFICATION carries no requester, no reporter and no ids, so the block would be an empty
 * heading. The editor renders that cell as not-applicable rather than offering a toggle that does
 * nothing.
 */
export function supportsAdminInfo(eventType: string): boolean {
  return eventType !== 'TEST_NOTIFICATION' && DEFAULT_ROUTING[eventType] !== undefined;
}

/**
 * Merge stored routing over the defaults. Unknown event types are ignored and missing cells fall back,
 * so a config written by an older version — or one hand-edited into a partial state — still resolves to
 * complete, valid routing.
 */
export function readRouting(raw: unknown): RoutingTable {
  const table: RoutingTable = {};
  for (const event of ROUTED_EVENTS) table[event] = { ...DEFAULT_ROUTING[event] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return table;

  for (const [event, value] of Object.entries(raw as Record<string, unknown>)) {
    const current = table[event];
    if (!current || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const cell = value as Record<string, unknown>;
    if (typeof cell.user === 'boolean') current.user = cell.user;
    if (typeof cell.admin === 'boolean') current.admin = cell.admin;
    if (typeof cell.adminInfo === 'boolean') current.adminInfo = cell.adminInfo;
    // A toggle the event cannot honour is normalized away rather than stored as a lie.
    if (!supportsAdminInfo(event)) current.adminInfo = false;
  }

  return table;
}

/** Routing for one event; an unrouted type reaches nobody rather than falling back to a default. */
export function routingFor(table: RoutingTable, eventType: string): EventRouting {
  return table[eventType] ?? { user: false, admin: false, adminInfo: false };
}
