// The Seerr user roster: identity and admin status pulled from Seerr rather than retyped by hand.
//
// The roster is stored in plugin CONFIG rather than in ctx.storage, which looks odd until you see the
// constraint: the config editor runs in an opaque-origin sandbox with no network, and its only channel
// is postMessage to the dashboard, which speaks exactly `config:get` and `config:save`. Config is
// therefore the only thing the editor can ever read. A plugin cannot write its own config either, so
// the roster is refreshed out-of-band by `refresh-roster.mjs` — deliberately manual, never automatic.
//
// Operators own only two fields per person: a phone number and an on/off toggle.

/** Seerr's Permission.ADMIN bit (server/lib/permissions.ts). Admins hold every permission implicitly. */
export const SEERR_ADMIN_PERMISSION = 2;

export function isSeerrAdmin(permissions: unknown): boolean {
  return typeof permissions === 'number' && (permissions & SEERR_ADMIN_PERMISSION) !== 0;
}

/** One Seerr account, as cached by the refresh command. */
export interface RosterEntry {
  id: number;
  name: string;
  email: string;
  isAdmin: boolean;
}

/** What the operator configures per person. Everything else comes from the roster. */
export interface UserMappingRow {
  seerrUserId: number | null;
  number: string;
  enabled: boolean;
}

/** Narrow a raw Seerr `/api/v1/user` record to the fields worth caching. */
export function toRosterEntry(record: Record<string, unknown>): RosterEntry | null {
  const id = Number(record.id);
  if (!Number.isFinite(id)) return null;
  const name = typeof record.displayName === 'string' && record.displayName.trim()
    ? record.displayName.trim()
    : typeof record.username === 'string'
      ? record.username.trim()
      : '';
  return {
    id,
    name,
    email: typeof record.email === 'string' ? record.email.trim().toLowerCase() : '',
    isAdmin: isSeerrAdmin(record.permissions),
  };
}

export function readRoster(raw: unknown): RosterEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RosterEntry[] = [];
  for (const entry of raw) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const id = Number(row.id);
    if (!Number.isFinite(id)) continue;
    out.push({
      id,
      name: typeof row.name === 'string' ? row.name : '',
      email: typeof row.email === 'string' ? row.email.toLowerCase() : '',
      isAdmin: row.isAdmin === true,
    });
  }
  return out;
}

/**
 * Identity for one mapping row: the roster entry when the refresh has seen this id, otherwise whatever
 * the row itself carries.
 *
 * The fallback is what makes a stale or never-run roster harmless rather than silently un-routable, and
 * it is also the migration path from the pre-roster config shape, where `email` / `username` / `isAdmin`
 * lived on the row. The roster wins when both exist — Seerr is the authority on who is an admin.
 */
export function identityFor(
  row: UserMappingRow,
  legacy: { email?: string; username?: string; isAdmin?: boolean },
  roster: Map<number, RosterEntry>,
): { email: string; username: string; isAdmin: boolean } {
  const entry = row.seerrUserId === null ? undefined : roster.get(row.seerrUserId);
  if (entry) {
    return { email: entry.email, username: entry.name.toLowerCase(), isAdmin: entry.isAdmin };
  }
  return {
    email: (legacy.email ?? '').toLowerCase(),
    username: (legacy.username ?? '').toLowerCase(),
    isAdmin: legacy.isAdmin === true,
  };
}

export function rosterIndex(roster: RosterEntry[]): Map<number, RosterEntry> {
  return new Map(roster.map((entry) => [entry.id, entry]));
}
