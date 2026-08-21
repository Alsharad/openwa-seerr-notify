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
  if (!deps.baseUrl) return { ok: false, message: 'no Jellyseerr/Overseerr URL configured' };
  if (!deps.apiKey) return { ok: false, message: 'no Seerr API key configured' };

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
    return {
      ok: false,
      message:
        `cannot reach ${deps.baseUrl} — ${describe(statusResult.reason)}. ` +
        'Check the URL, the manifest net.allow entry, and SSRF_ALLOWED_HOSTS for a private address.',
    };
  }

  const status = statusResult.value;
  if (!status.ok) {
    return { ok: false, message: `${deps.baseUrl} answered HTTP ${status.status} on /api/v1/status` };
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
      message: `${deps.baseUrl} responded, but not with a Seerr status payload — is that the right URL?`,
    };
  }

  if (authResult.status === 'rejected') {
    return { ok: false, version, message: `Seerr ${version} reachable, but the API key check failed: ${describe(authResult.reason)}` };
  }

  const auth = authResult.value;
  if (auth.status === 401 || auth.status === 403) {
    return { ok: false, version, message: `Seerr ${version} reachable, but the API key was rejected (HTTP ${auth.status})` };
  }
  if (!auth.ok) {
    return { ok: false, version, message: `Seerr ${version} reachable, but /api/v1/user answered HTTP ${auth.status}` };
  }

  return { ok: true, version, message: `Seerr ${version} at ${deps.baseUrl} — API key accepted` };
}
