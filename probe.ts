// Connectivity probe behind the dashboard's health-check button.
//
// The declarative config form cannot carry a custom "Test" button, and a `configUi` iframe has no
// network of its own — its postMessage bridge only speaks config:get / config:save. So the test lives
// where the plugin CAN reach Seerr: `healthCheck()`, which the dashboard already exposes as a button on
// the plugin row (GET /api/plugins/:id/health) and renders as a toast carrying `message`.
//
// The host allows healthCheck 5 s total (SANDBOX_HEALTH_TIMEOUT_MS), so both requests run concurrently
// on a budget well inside it. Two endpoints are needed because they prove different things:
//   GET /api/v1/status  — public in Seerr (auth middleware is `checkUser`, not `isAuthenticated`), so it
//                         proves the URL is a Seerr instance and reports its version, but says nothing
//                         about the API key.
//   GET /api/v1/user    — behind `isAuthenticated()`, so a 200 proves the API key is accepted.

import type { PluginNetResponse } from './types/openwa';
import type { NetFetch } from './seerr-client.ts';

/** Comfortably inside the host's 5 s healthCheck budget, leaving room for both calls and the reply. */
export const PROBE_TIMEOUT_MS = 3500;

export interface ProbeDeps {
  fetch: NetFetch;
  baseUrl: string;
  apiKey: string;
}

export interface ProbeResult {
  ok: boolean;
  /** Operator-facing summary, rendered in the dashboard toast. */
  message: string;
  version?: string;
}

/** Seerr's own error envelope leaks internals; keep the operator-facing text short and actionable. */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}

/** The host as SSRF_ALLOWED_HOSTS wants it — a bare hostname or IP literal, no scheme, no port. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return url;
  }
}

async function get(deps: ProbeDeps, path: string, withKey: boolean): Promise<PluginNetResponse> {
  return deps.fetch(`${deps.baseUrl}${path}`, {
    headers: withKey ? { 'X-Api-Key': deps.apiKey, Accept: 'application/json' } : { Accept: 'application/json' },
    timeoutMs: PROBE_TIMEOUT_MS,
  });
}

/**
 * Check that the configured URL is a reachable Seerr instance and that the API key is accepted.
 * Never throws — every outcome is a message the operator can act on.
 */
export async function probeSeerr(deps: ProbeDeps): Promise<ProbeResult> {
  if (!deps.baseUrl) return { ok: false, message: 'Add your Seerr address on the Connection tab.' };
  if (!deps.apiKey) return { ok: false, message: 'Add your Seerr API key on the Connection tab.' };

  // `checkUpdateAvailable=false` keeps /status from calling out to GitHub for an update check, which
  // would otherwise run on the probe's budget (measured: 270 ms vs 6 ms on Seerr 3.4.1). It must be the
  // literal 'false': that build validates the query against its OpenAPI schema and rejects an empty
  // value or '0' with a 400. On an older Seerr, which coerced the raw value in an `if`, 'false' is
  // truthy and the update check simply still happens — slower, never an error.
  const [statusResult, authResult] = await Promise.allSettled([
    get(deps, '/api/v1/status?checkUpdateAvailable=false', false),
    get(deps, '/api/v1/user?take=1&skip=0', true),
  ]);

  if (statusResult.status === 'rejected') {
    const reason = describe(statusResult.reason);

    // The single most likely first-run failure, because a self-hosted Seerr is nearly always on a LAN:
    // OpenWA's SSRF guard refuses private addresses unless the operator opts in. The guard's own wording
    // — "Blocked internal address: 192.168.8.25" — states the rule and not the remedy, and repeating the
    // address after "Cannot reach <url>" says it twice. Give the exact variable and value instead.
    if (/blocked internal address/i.test(reason)) {
      return {
        ok: false,
        message:
          `OpenWA blocks private addresses, so it will not call ${deps.baseUrl}. ` +
          `Set SSRF_ALLOWED_HOSTS=${hostOf(deps.baseUrl)} in the gateway's environment and restart it.`,
      };
    }

    // The address belongs in a FAILURE — it is the thing to check. On success it is noise the operator
    // just typed in on the previous tab.
    return { ok: false, message: `Cannot reach ${deps.baseUrl} — ${reason}.` };
  }

  const status = statusResult.value;
  if (!status.ok) {
    return { ok: false, message: `${deps.baseUrl} answered HTTP ${status.status}.` };
  }

  let version: string | undefined;
  try {
    const body = JSON.parse(status.body) as { version?: unknown; commitTag?: unknown };
    if (typeof body.version === 'string' && body.version) version = body.version;
  } catch {
    // fall through to the not-a-Seerr message below
  }

  if (!version) {
    return {
      ok: false,
      message: `${deps.baseUrl} responded, but it is not a Seerr server.`,
    };
  }

  if (authResult.status === 'rejected') {
    return { ok: false, version, message: `Seerr v${version} reachable, but the API key could not be checked: ${describe(authResult.reason)}.` };
  }

  const auth = authResult.value;
  if (auth.status === 401 || auth.status === 403) {
    return { ok: false, version, message: `Seerr v${version} reachable, but the API key was rejected.` };
  }
  if (!auth.ok) {
    return { ok: false, version, message: `Seerr v${version} reachable, but the user list answered HTTP ${auth.status}.` };
  }

  // Just the one fact the dashboard's own toast cannot carry. It already renders a success icon and a
  // title, so restating the verdict — or the address that was checked — says nothing twice over.
  return { ok: true, version, message: `Seerr v${version}` };
}
