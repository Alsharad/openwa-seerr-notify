// The plugin talking to its own gateway over loopback.
//
// Everything here exists because a plugin cannot write its own config through the supported surface:
// `PluginContext.config` is a read-only getter, and the only writer is `PUT /api/plugins/:id/config`,
// which needs an ADMIN, unscoped API key. The full argument — and what this deliberately does not do —
// is in the header of roster-refresh.ts, which was the first caller.
//
// Two rules hold for every call in this file:
//   • It goes through Node's global fetch, NOT ctx.net.fetch. The SSRF guard blocks loopback, and
//     widening SSRF_ALLOWED_HOSTS to admit 127.0.0.1 would open loopback for every plugin on the host.
//   • The admin key is read at call time from the host's own key file and never stored, logged or
//     copied into config.

/** The subset of Node's fetch response this module needs; narrowed so tests can hand in a plain object. */
export interface SelfResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type SelfFetch = (url: string, init?: RequestInit) => Promise<SelfResponse>;

export interface GatewayDeps {
  /** Node's global fetch, for the loopback self-call only. */
  selfFetch: SelfFetch;
  /** Resolves the gateway admin key, or throws with an actionable message. */
  readApiKey: () => Promise<string>;
  /** The gateway's own base URL, e.g. http://127.0.0.1:2785. */
  selfUrl: string;
  pluginId: string;
}

export interface GatewayResponse {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * One authenticated call to the gateway's own API. Never throws for an HTTP status — the caller decides
 * what a 404 means (for `regenerate-secret` it is a missing instance; for a config write it is a bug) —
 * but does throw when the key cannot be read or the socket refuses, because neither is recoverable here.
 */
export async function gatewayRequest(deps: GatewayDeps, path: string, init: RequestInit = {}): Promise<GatewayResponse> {
  const apiKey = await deps.readApiKey();
  const res = await deps.selfFetch(`${deps.selfUrl}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init.headers ?? {}), 'X-API-Key': apiKey },
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

/**
 * Merge a partial config into the plugin's stored config.
 *
 * The host merges shallowly (`plugin.config = {...plugin.config, ...config}`), so a patch touches only
 * the keys it names — every other setting, including the Seerr API key, is left exactly as it is. That
 * property is what makes it safe for a background task to write config while the operator has the
 * editor open on other tabs.
 */
export async function writePluginConfig(deps: GatewayDeps, patch: Record<string, unknown>): Promise<void> {
  const res = await gatewayRequest(deps, `/api/plugins/${deps.pluginId}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: patch }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.body.slice(0, 200)}`);
}
