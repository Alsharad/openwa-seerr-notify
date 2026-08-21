// Operator config parsing. The host's config form is advisory, never enforced server-side, so every
// field is validated here defensively.
//
// Defaults declared at the TOP LEVEL of `configSchema` are seeded into the stored config by the host at
// load, but defaults nested under `items`/`properties` are NOT — so the per-row user fields below are
// defaulted in code rather than trusted to arrive.

import { identityFor, readRoster, rosterIndex } from './roster.ts';
import type { RosterEntry } from './roster.ts';
import { readRouting } from './routing.ts';
import type { RoutingTable } from './routing.ts';

export interface SeerrUser {
  /** As the operator typed it, kept for logs and dedup. */
  number: string;
  /** WhatsApp chat id derived from `number`. */
  chatId: string;
  seerrUserId: number | null;
  email: string;
  username: string;
  isAdmin: boolean;
}

/**
 * Which sections a Now Available message renders. Every one is ON and there is no operator switch: nine
 * toggles for one message type was more configuration surface than the decision deserved. The type and
 * the formatter's branches are kept — they are what the formatter tests exercise per section — but the
 * only value ever constructed is {@link ALL_SECTIONS}.
 */
export interface MediaAvailableFlags {
  showReleaseDate: boolean;
  showRatings: boolean;
  showOverview: boolean;
  showGenres: boolean;
  showDirector: boolean;
  showCast: boolean;
  showTrailer: boolean;
  showSeasons: boolean;
  showCollection: boolean;
}

export interface SeerrConfig {
  jellyseerr: { url: string; apiKey: string; enabled: boolean };
  /** URL and key are both present. Separates "switched off" from "never filled in" in health output. */
  jellyseerrConfigured: boolean;
  requireMappedUser: boolean;
  fallbackSessionId?: string;
  users: SeerrUser[];
  /** Cached Seerr accounts, refreshed out-of-band by refresh-roster.mjs. */
  roster: RosterEntry[];
  rosterSyncedAt: string;
  /** Per-event delivery rules, defaulted from DEFAULT_ROUTING. */
  routing: RoutingTable;
  sendPoster: boolean;
  flags: MediaAvailableFlags;
  debug: boolean;
}

export const ALL_SECTIONS: MediaAvailableFlags = {
  showReleaseDate: true,
  showRatings: true,
  showOverview: true,
  showGenres: true,
  showDirector: true,
  showCast: true,
  showTrailer: true,
  showSeasons: true,
  showCollection: true,
};

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const bool = (v: unknown, fallback: boolean): boolean => {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
};

/** Normalize a phone number to a WhatsApp chat id "<digits>@c.us". Undefined when it holds no digits. */
export function phoneToChatId(phone: unknown): string | undefined {
  if (typeof phone !== 'string') return undefined;
  const digits = phone.replace(/[^\d]/g, '');
  return digits.length > 0 ? `${digits}@c.us` : undefined;
}

/**
 * A chat id reduced to what a diagnostic needs: enough to correlate two lines about the same recipient,
 * not enough to identify them. Debug output gets pasted into issues, and a WhatsApp id is a phone number.
 */
export function maskChatId(chatId: string): string {
  const [local, domain = 'c.us'] = chatId.split('@');
  return local.length <= 4 ? `***@${domain}` : `***${local.slice(-4)}@${domain}`;
}

/**
 * Build the deliverable recipient list from the operator's rows plus the cached Seerr roster.
 *
 * A row contributes a recipient only when it is enabled AND carries a usable number — a disabled row or
 * one with no digits can never be delivered to, so it is dropped here rather than carried as a broken
 * target through routing. Identity and admin status come from the roster; see identityFor for what
 * happens when the roster has not seen that id.
 */
function readUsers(raw: unknown, roster: Map<number, RosterEntry>): SeerrUser[] {
  if (!Array.isArray(raw)) return [];
  const out: SeerrUser[] = [];
  for (const entry of raw) {
    const row = (entry ?? {}) as Record<string, unknown>;
    // Absent means enabled: a row only exists because the operator ticked it, and a config written by an
    // older version has no `enabled` key at all.
    if (!bool(row.enabled, true)) continue;

    const number = str(row.number);
    const chatId = phoneToChatId(number);
    if (!chatId) continue;

    const parsedId = Number(row.seerrUserId);
    const seerrUserId = Number.isFinite(parsedId) ? parsedId : null;
    const identity = identityFor(
      { seerrUserId, number, enabled: true },
      { email: str(row.email), username: str(row.username), isAdmin: row.isAdmin === true },
      roster,
    );

    out.push({ number, chatId, seerrUserId, ...identity });
  }
  return out;
}

/**
 * Parse and validate operator config. Throws when the plugin could not deliver anything at all, so the
 * failure surfaces in the dashboard at enable time instead of once per webhook.
 */
export function readConfig(raw: Record<string, unknown>): SeerrConfig {
  const roster = readRoster(raw.seerrRoster);
  const users = readUsers(raw.users, rosterIndex(roster));
  if (users.length === 0) {
    throw new Error(
      'seerr-notify: no recipients enabled — open Configure > Recipients, enable at least one Seerr user and give them a WhatsApp number',
    );
  }

  const url = str(raw.jellyseerrUrl).replace(/\/+$/, '');
  const apiKey = str(raw.jellyseerrApiKey);
  const fallbackSessionId = str(raw.fallbackSessionId);

  return {
    jellyseerr: {
      url,
      apiKey,
      // Enrichment needs all three: the toggle, a base URL and a key. Missing any one degrades the
      // plugin to payload-only formatting rather than failing the delivery.
      enabled: bool(raw.enrichmentEnabled, true) && url !== '' && apiKey !== '',
    },
    jellyseerrConfigured: url !== '' && apiKey !== '',
    requireMappedUser: bool(raw.requireMappedUser, true),
    fallbackSessionId: fallbackSessionId || undefined,
    users,
    roster,
    rosterSyncedAt: str(raw.rosterSyncedAt),
    routing: readRouting(raw.routing),
    sendPoster: bool(raw.sendPoster, true),
    flags: ALL_SECTIONS,
    debug: bool(raw.debug, false),
  };
}
