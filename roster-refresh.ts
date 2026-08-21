// In-dashboard roster refresh: the plugin fetches its Seerr user list and writes it back into its own
// config, so the Recipients tab has a working "Refresh from Seerr" button.
//
// ⚠️ THIS STEPS OUTSIDE THE PLUGIN CAPABILITY MODEL, DELIBERATELY AND WITH THE OPERATOR'S CONSENT.
//
// Nothing in the supported surface can do this. The config editor is an opaque-origin sandbox with no
// network whose only channel speaks `config:get` / `config:save`, and `PluginContext.config` is a
// read-only getter — a plugin cannot write its own config. The only writer is
// `PUT /api/plugins/:id/config`, which requires an ADMIN, unscoped API key.
//
// So this reads the gateway's own admin key off disk and calls that endpoint. Two consequences worth
// keeping in view:
//   • The key is never stored in config; it is read at call time from the host's key file. The worker is
//     crash containment and not a security boundary (OpenWA's own docs say so), so plugin code could
//     always reach that file — this makes the reach explicit rather than adding a new one.
//   • The self-call goes through Node's global fetch, NOT ctx.net.fetch. The SSRF guard blocks loopback,
//     and widening SSRF_ALLOWED_HOSTS to admit 127.0.0.1 would open loopback for EVERY plugin on the
//     host. Keeping the exception local to that one call is the narrower choice. The Seerr fetch below
//     still goes through the guarded ctx.net.fetch.
//
// Both live in gateway.ts now, shared with the Setup tab (setup.ts); this file keeps the Seerr half.

import { toRosterEntry } from './roster.ts';
import type { RosterEntry } from './roster.ts';
import { writePluginConfig } from './gateway.ts';
import type { GatewayDeps } from './gateway.ts';
import type { NetFetch } from './seerr-client.ts';

/** Where the gateway writes its seeded admin key. Docker path first, then a bare-metal checkout. */
export const API_KEY_FILE_CANDIDATES = ['/app/data/.api-key', './data/.api-key'];

const SEERR_PAGE_SIZE = 100;
/** A refresh runs in the background of a config save, so it can afford a longer budget than a delivery. */
const SEERR_TIMEOUT_MS = 15_000;

export interface RefreshDeps extends GatewayDeps {
  /** ctx.net.fetch — SSRF-guarded, scoped to the manifest net.allow host list. */
  seerrFetch: NetFetch;
  log: (message: string, meta?: Record<string, unknown>) => void;
}

export interface RefreshResult {
  ok: boolean;
  message: string;
  count?: number;
  admins?: number;
}

/**
 * Page through Seerr's user list. A large install does not fit one page, and a truncated roster would
 * silently drop recipients from the editor.
 */
export async function fetchSeerrRoster(
  fetchFn: NetFetch,
  baseUrl: string,
  apiKey: string,
): Promise<RosterEntry[]> {
  const roster: RosterEntry[] = [];

  for (let skip = 0; ; skip += SEERR_PAGE_SIZE) {
    const res = await fetchFn(`${baseUrl}/api/v1/user?take=${SEERR_PAGE_SIZE}&skip=${skip}`, {
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      timeoutMs: SEERR_TIMEOUT_MS,
    });
    if (!res.ok) throw new Error(`Seerr /api/v1/user answered HTTP ${res.status}`);

    const body = JSON.parse(res.body) as { results?: unknown; pageInfo?: { results?: number } };
    const page = Array.isArray(body.results) ? body.results : [];
    for (const record of page) {
      const entry = toRosterEntry((record ?? {}) as Record<string, unknown>);
      if (entry) roster.push(entry);
    }

    const total = body.pageInfo?.results;
    if (page.length < SEERR_PAGE_SIZE || (typeof total === 'number' && roster.length >= total)) break;
    // Defensive stop: a provider that ignores `skip` would otherwise loop forever.
    if (skip > 10_000) break;
  }

  return roster.sort((a, b) => a.id - b.id);
}

/**
 * Fetch the roster and write it back into plugin config.
 *
 * `token` is echoed into the written config as `rosterRefreshRequestedAt`. That is what stops the write
 * from looping: the write fires onConfigChange again, and the handler sees a token it has already
 * processed and does nothing.
 */
export async function refreshRoster(
  deps: RefreshDeps,
  seerr: { url: string; apiKey: string },
  token: string,
): Promise<RefreshResult> {
  if (!seerr.url || !seerr.apiKey) {
    return { ok: false, message: 'Seerr URL and API key must be configured before refreshing the roster' };
  }

  let roster: RosterEntry[];
  try {
    roster = await fetchSeerrRoster(deps.seerrFetch, seerr.url, seerr.apiKey);
  } catch (err) {
    return { ok: false, message: `could not read the Seerr user list: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Only the roster keys: the host merges shallowly, so everything else is left exactly as it is —
  // including the Seerr API key, which is never read or rewritten here. The token is echoed back so the
  // write cannot loop (see the note above).
  try {
    await writePluginConfig(deps, {
      seerrRoster: roster,
      rosterSyncedAt: new Date().toISOString(),
      rosterRefreshRequestedAt: token,
    });
  } catch (err) {
    return { ok: false, message: `writing the roster back failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const admins = roster.filter((entry) => entry.isAdmin).length;
  return { ok: true, count: roster.length, admins, message: `roster refreshed: ${roster.length} Seerr account(s), ${admins} admin(s)` };
}
