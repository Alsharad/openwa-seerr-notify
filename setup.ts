// The Setup tab's three buttons, on the plugin side.
//
// All of them exist for the same reason: the config editor is an opaque-origin sandbox with no network,
// so it cannot ask the gateway anything. It asks the PLUGIN instead, by saving a changed
// `setupRequestedAt` token. That save arrives in onConfigChange, this module does the work, and the
// result is written back into the `setup` config key for the editor to render on its next handshake.
//
// What the three do:
//   • instances — read this plugin's ingress instances, so the editor can show the exact webhook URL
//     to paste into Seerr instead of asking the operator to assemble one by hand.
//   • secret    — rotate an instance's ingress secret and surface the plaintext, which the gateway
//     reveals exactly once, in the response to the rotation itself.
//   • update    — see update-check.ts.
//
// The rotated secret is stored in plugin config in the clear, and that is a deliberate trade: the API
// reveals it once and the editor cannot receive it any other way (a `secret: true` field arrives at the
// iframe as '***'). It is the credential for one ingress route on the operator's own LAN, it is readable
// only by an admin API key — the same key class that could rotate it again anyway — and the editor
// offers a Clear button next to it. Copy it into Seerr, then clear it.

import { gatewayRequest, writePluginConfig } from './gateway.ts';
import type { GatewayDeps } from './gateway.ts';
import { checkForUpdate } from './update-check.ts';
import type { UpdateState } from './update-check.ts';
import type { NetFetch } from './seerr-client.ts';

/** The ingress route this plugin claims; the manifest declares exactly one. */
const ROUTE = 'seerr';

export interface SetupInstance {
  instanceId: string;
  /** Session the instance is bound to, or '' for all sessions. */
  sessionScope: string;
  enabled: boolean;
  /** Full ingress URL, or a path when the gateway has no BASE_URL set. */
  url: string;
  /** True when `url` is a bare path the operator must prefix with their own OpenWA host. */
  relative: boolean;
}

/** Everything the plugin writes for the Setup tab. Written whole, so callers merge before writing. */
export interface SetupState {
  /** The running plugin version. Written on every pass, so the panel can state it even when the update
   *  check has never run — or has been switched off. */
  version: string;
  instances: SetupInstance[];
  instancesAt: string;
  /** Plaintext ingress secret from the last rotation, until the operator clears it. */
  secret: string;
  /** Which instance `secret` belongs to. */
  secretFor: string;
  secretAt: string;
  update: UpdateState | null;
  /** Echoes the token that produced this state — how the editor knows its click landed. */
  lastAction: string;
  /** Empty on success; the reason on failure, rendered in the editor. */
  error: string;
}

export const EMPTY_SETUP: SetupState = {
  version: '',
  instances: [],
  instancesAt: '',
  secret: '',
  secretFor: '',
  secretAt: '',
  update: null,
  lastAction: '',
  error: '',
};

/** Read the stored `setup` object defensively — it is operator-visible config like any other key. */
export function readSetup(raw: unknown): SetupState {
  const row = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    version: str(row.version),
    instances: Array.isArray(row.instances) ? (row.instances as SetupInstance[]) : [],
    instancesAt: str(row.instancesAt),
    secret: str(row.secret),
    secretFor: str(row.secretFor),
    secretAt: str(row.secretAt),
    update: (row.update ?? null) as UpdateState | null,
    lastAction: str(row.lastAction),
    error: str(row.error),
  };
}

export interface SetupAction {
  name: 'instances' | 'secret' | 'update';
  /** The instance id, for `secret`. Empty otherwise. */
  arg: string;
  /** The whole token, echoed back so the write cannot loop and the editor can confirm the round trip. */
  token: string;
}

/**
 * Parse the editor's token: `<action>|<arg>|<iso>`.
 *
 * The timestamp is what makes each click distinct; the action and arg are what the plugin acts on. An
 * unrecognized action returns null and is ignored, so a config written by a newer editor cannot make an
 * older plugin do something arbitrary.
 */
export function parseSetupAction(raw: unknown): SetupAction | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const [name, arg = ''] = raw.split('|');
  if (name !== 'instances' && name !== 'secret' && name !== 'update') return null;
  if (name === 'secret' && !/^[a-zA-Z0-9_-]{1,64}$/.test(arg)) return null;
  return { name, arg, token: raw };
}

/** This plugin's ingress instances, newest-visible-first as the gateway returns them. */
export async function discoverInstances(deps: GatewayDeps): Promise<SetupInstance[]> {
  const res = await gatewayRequest(deps, `/api/integration/plugins/${deps.pluginId}/instances`);
  if (!res.ok) throw new Error(`the gateway answered HTTP ${res.status} for the instance list`);

  const rows = JSON.parse(res.body) as Array<Record<string, unknown>>;
  if (!Array.isArray(rows)) throw new Error('the gateway returned an unexpected instance list');

  return rows.map((row) => {
    const urls = Array.isArray(row.ingressUrls) ? (row.ingressUrls as Array<Record<string, unknown>>) : [];
    const match = urls.find((u) => u.route === ROUTE) ?? urls[0];
    const url = typeof match?.url === 'string' ? match.url : '';
    return {
      instanceId: String(row.instanceId ?? ''),
      sessionScope: typeof row.sessionScope === 'string' ? row.sessionScope : '',
      enabled: row.enabled !== false,
      url,
      // buildIngressUrls returns a bare path when BASE_URL is unset — the operator has to supply the host.
      relative: url.startsWith('/'),
    };
  });
}

/**
 * Rotate an instance's ingress secret and return the new plaintext.
 *
 * This BREAKS the running webhook until the new value is pasted into Seerr — the old secret stops
 * verifying the moment this returns, and Seerr starts getting 401s. The editor says so before the
 * operator commits to it; there is no way to read the existing secret back instead, because the gateway
 * masks it on every read but the one that mints it.
 */
export async function rotateSecret(deps: GatewayDeps, instanceId: string): Promise<string> {
  const res = await gatewayRequest(
    deps,
    `/api/integration/plugins/${deps.pluginId}/instances/${encodeURIComponent(instanceId)}/regenerate-secret`,
    { method: 'POST' },
  );
  if (res.status === 404) throw new Error(`there is no ingress instance called "${instanceId}"`);
  if (!res.ok) throw new Error(`the gateway answered HTTP ${res.status} when rotating the secret`);

  const body = JSON.parse(res.body) as { secret?: unknown };
  const secret = typeof body.secret === 'string' ? body.secret : '';
  if (!secret || secret === '***') throw new Error('the gateway did not reveal the new secret');
  return secret;
}

export interface SetupRunDeps extends GatewayDeps {
  /** ctx.net.fetch — SSRF-guarded, scoped to the manifest net.allow list (api.github.com). */
  netFetch: NetFetch;
  /** Baked from manifest.repository at build time. */
  repoSlug: string;
  version: string;
  now?: () => Date;
}

export interface SetupRunResult {
  ok: boolean;
  message: string;
  /** The state that was written, for logging and tests. */
  state: SetupState;
}

/**
 * Run one Setup action and write the result back.
 *
 * `previous` is the stored state, so an action only replaces what it owns: checking for an update must
 * not blank the instance list, and rotating a secret must not blank the update banner. Failures are
 * written too — an operator staring at a button that did nothing deserves the reason in the editor, not
 * only in the gateway log.
 */
export async function runSetupAction(
  deps: SetupRunDeps,
  previous: SetupState,
  action: SetupAction,
): Promise<SetupRunResult> {
  const now = deps.now ?? (() => new Date());
  const state: SetupState = { ...previous, version: deps.version, lastAction: action.token, error: '' };
  let message = '';

  try {
    if (action.name === 'instances') {
      state.instances = await discoverInstances(deps);
      state.instancesAt = now().toISOString();
      message = `found ${state.instances.length} ingress instance(s)`;
    } else if (action.name === 'secret') {
      state.secret = await rotateSecret(deps, action.arg);
      state.secretFor = action.arg;
      state.secretAt = now().toISOString();
      // The URL cannot change under a rotation, but a first-time operator clicks these in either order;
      // refreshing here means the tab is never half-populated. A failure to list is not a failure to
      // rotate, so it is swallowed.
      state.instances = await discoverInstances(deps).catch(() => state.instances);
      message = `rotated the ingress secret for "${action.arg}"`;
    } else {
      state.update = await checkForUpdate(deps.netFetch, deps.repoSlug, deps.version, now);
      message = state.update.available
        ? `version ${state.update.latest} is available (running ${deps.version})`
        : `no update: ${state.update.note}`;
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    message = state.error;
  }

  // The token is CLEARED by the write and preserved only as `setup.lastAction`, which is what the editor
  // reads to confirm its click landed. Two things follow: the write cannot loop (the next config change
  // carries no action at all), and a token can never replay — a stale `secret|…` surviving in config
  // would otherwise rotate the ingress secret again after an unrelated restart, silently 401'ing Seerr.
  try {
    await writePluginConfig(deps, { setup: state, setupRequestedAt: '' });
  } catch (err) {
    return {
      ok: false,
      state,
      message: `${message || 'setup action ran'}, but writing it back failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ok: state.error === '', message, state };
}

/**
 * The background pass that runs shortly after enable, so the Setup tab is already populated the first
 * time it is opened and the update banner can appear without anyone asking for it.
 *
 * It writes at most once, and only when it has something new: a config write per gateway restart is
 * cheap, a config write per restart that also races the operator's open editor for no reason is not.
 */
export async function refreshSetupInBackground(
  deps: SetupRunDeps,
  previous: SetupState,
  opts: { checkUpdates: boolean; intervalMs: number },
): Promise<SetupState | null> {
  const now = deps.now ?? (() => new Date());
  const state: SetupState = { ...previous };
  // A version that has moved is itself worth a write: it is how the panel reports the running build
  // after an upgrade, without waiting for a release check that may be switched off.
  let changed = state.version !== deps.version;
  state.version = deps.version;

  try {
    state.instances = await discoverInstances(deps);
    state.instancesAt = now().toISOString();
    changed = true;
  } catch {
    // Loopback or the key file is unavailable — the Setup tab's Refresh button reports it properly.
  }

  const lastCheck = Date.parse(previous.update?.checkedAt ?? '');
  const due = !Number.isFinite(lastCheck) || now().getTime() - lastCheck >= opts.intervalMs;
  if (opts.checkUpdates && due) {
    state.update = await checkForUpdate(deps.netFetch, deps.repoSlug, deps.version, now);
    changed = true;
  }

  if (!changed) return null;
  await writePluginConfig(deps, { setup: state });
  return state;
}
