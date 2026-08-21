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

/** The Seerr connection alone, readable without a recipient list — see readSeerrConnection. */
export interface SeerrConnection {
  url: string;
  apiKey: string;
  /** Both settings are present, so Seerr can be called. Identical to `configured`; kept as the name the
   *  delivery path reads, since it asks "can I enrich this?" rather than "did the operator finish setup?". */
  enabled: boolean;
  configured: boolean;
}

export interface SeerrConfig {
  seerr: { url: string; apiKey: string; enabled: boolean };
  /** URL and key are both present. Separates "switched off" from "never filled in" in health output. */
  seerrConfigured: boolean;
  requireMappedUser: boolean;
  users: SeerrUser[];
  /** Cached Seerr accounts, refreshed by the Recipients tab or refresh-roster.mjs. */
  roster: RosterEntry[];
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
 * The Seerr connection settings on their own.
 *
 * Split out of readConfig because the health check has to report on the connection even when readConfig
 * refuses the config as undeliverable: on a fresh install there are no recipients yet, and "test my Seerr
 * settings" is the button an operator reaches for BEFORE mapping anyone.
 *
 * There is no switch for this any more. The connection is what the recipient list is built from — a
 * Seerr account is the only thing that can be mapped to a number — so a plugin without one has nobody to
 * deliver to, and an "enrichment off" mode only ever produced thinner messages for no gain. A delivery
 * whose enrichment call fails still goes out from the payload alone; that is a degraded call, not a mode.
 */
export function readSeerrConnection(raw: Record<string, unknown>): SeerrConnection {
  // `jellyseerr*` are the pre-1.13 spellings. They are still read so an install that has not been
  // migrated keeps working on the version that renames them; index.ts moves the values across once and
  // blanks the old keys, after which this fallback never fires again.
  const url = (str(raw.seerrUrl) || str(raw.jellyseerrUrl)).replace(/\/+$/, '');
  const apiKey = str(raw.seerrApiKey) || str(raw.jellyseerrApiKey);
  return {
    url,
    apiKey,
    enabled: url !== '' && apiKey !== '',
    configured: url !== '' && apiKey !== '',
  };
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
      'No recipients yet — tick someone on the Recipients tab and add their WhatsApp number.',
    );
  }

  const seerr = readSeerrConnection(raw);

  return {
    seerr: { url: seerr.url, apiKey: seerr.apiKey, enabled: seerr.enabled },
    seerrConfigured: seerr.configured,
    requireMappedUser: bool(raw.requireMappedUser, true),
    users,
    roster,
    routing: readRouting(raw.routing),
    sendPoster: bool(raw.sendPoster, true),
    flags: ALL_SECTIONS,
    debug: bool(raw.debug, false),
  };
}
