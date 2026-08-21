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
import { checkForUpdate, isNewer, pinnedDownloadUrl } from './update-check.ts';
import type { UpdateState } from './update-check.ts';
import type { NetFetch } from './seerr-client.ts';


/** Everything the plugin writes for the Setup tab. Written whole, so callers merge before writing. */
export interface SetupState {
  /** The running plugin version. Written on every pass, so the panel can state it even when the update
   *  check has never run — or has been switched off. */
  version: string;
  /**
   * The Seerr API key, mirrored so the Connection tab can show it.
   *
   * The host redacts `seerrApiKey` to '***' before config reaches the config UI, so the panel could
   * never display the stored one — which is why it first rendered as three characters and then as an
   * empty box. The plugin does have it. Mirroring it here is the same trade already made for the ingress
   * secret above: readable to an admin API key, in exchange for a credential field the operator can
   * actually see and copy. It makes the two credentials behave identically instead of one being a
   * special case with its own rules.
   */
  seerrApiKey: string;
  update: UpdateState | null;
  /** Version an install was started for, so the panel can say what is being installed. */
  upgradingTo: string;
  /** What the last "Send a test message" press did, rendered under the button. */
  testResult: string;
  /** Echoes the token that produced this state — how the editor knows its click landed. */
  lastAction: string;
  /** Empty on success; the reason on failure, rendered in the editor. */
  error: string;
}

export const EMPTY_SETUP: SetupState = {
  version: '',
  seerrApiKey: '',
  update: null,
  upgradingTo: '',
  testResult: '',
  lastAction: '',
  error: '',
};

/** Read the stored `setup` object defensively — it is operator-visible config like any other key. */
export function readSetup(raw: unknown): SetupState {
  const row = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    version: str(row.version),
    seerrApiKey: str(row.seerrApiKey),
    update: (row.update ?? null) as UpdateState | null,
    upgradingTo: str(row.upgradingTo),
    testResult: str(row.testResult),
    lastAction: str(row.lastAction),
    error: str(row.error),
  };
}

export interface SetupAction {
  name: 'update' | 'upgrade' | 'test';
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
  if (name !== 'update' && name !== 'upgrade' && name !== 'test') return null;
  return { name, arg, token: raw };
}



export interface SetupRunDeps extends GatewayDeps {
  /** ctx.net.fetch — SSRF-guarded, scoped to the manifest net.allow list (api.github.com). */
  netFetch: NetFetch;
  /** Baked from manifest.repository at build time. */
  repoSlug: string;
  version: string;
  /** Sends one test notification through the real delivery pipeline — see test-send.ts. */
  runTest: () => Promise<{ ok: boolean; message: string }>;
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
    if (action.name === 'upgrade') {
      return await installUpdate(deps, state, action);
    } else if (action.name === 'test') {
      const result = await deps.runTest();
      // Recorded either way. A test that found nobody to send to is the most useful thing this button can
      // report, and burying it in `error` would render it as a failure of the button rather than of the
      // configuration it is testing.
      state.testResult = result.message;
      if (!result.ok) state.error = result.message;
      message = result.message;
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
 * Install the release the last check found, in place, keeping config and the enabled state.
 *
 * The order here is the whole design. `POST /plugins/:id/update` unloads and replaces the plugin — which
 * is THIS worker — so anything that must be recorded has to be written BEFORE the call, and nothing can
 * be written after it succeeds. So the state is written first, carrying the token the editor is waiting
 * on and the version being installed; then the install runs. A failure leaves this worker alive to write
 * the reason; a success takes it down mid-request, and the replacement's background pass writes the new
 * version a few seconds later.
 *
 * Two properties make this safe enough to sit behind a button: the URL comes from the release feed of the
 * repository baked into the manifest at build time, never from config, and it is pinned to the sha256
 * the release publishes beside the zip — not one computed from the downloaded bytes.
 */
async function installUpdate(
  deps: SetupRunDeps,
  state: SetupState,
  action: SetupAction,
): Promise<SetupRunResult> {
  const update = state.update;
  if (!update || !update.available) {
    state.error = 'no newer release to install — check for updates first';
    await writePluginConfig(deps, { setup: state, setupRequestedAt: '' }).catch(() => undefined);
    return { ok: false, state, message: state.error };
  }

  let url: string;
  try {
    url = pinnedDownloadUrl(update);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    await writePluginConfig(deps, { setup: state, setupRequestedAt: '' }).catch(() => undefined);
    return { ok: false, state, message: state.error };
  }

  state.upgradingTo = update.latest;
  try {
    await writePluginConfig(deps, { setup: state, setupRequestedAt: '' });
  } catch (err) {
    // Refuse to install what cannot be recorded: the operator would watch the plugin restart with no
    // idea whether it worked, and a failure afterwards would have nowhere to report itself.
    return { ok: false, state, message: `could not record the install before starting it: ${String(err)}` };
  }

  const res = await gatewayRequest(deps, `/api/plugins/${deps.pluginId}/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  }).catch((err: unknown) => {
    // A rejection here is the expected shape of SUCCESS as often as failure: the worker is torn down
    // while its own request is in flight. Report it as started rather than failed.
    return { ok: true, status: 0, body: String(err) };
  });

  if (!res.ok) {
    state.error = `installing ${update.latest} failed: HTTP ${res.status} ${res.body.slice(0, 200)}`;
    state.upgradingTo = '';
    await writePluginConfig(deps, { setup: state, setupRequestedAt: '' }).catch(() => undefined);
    return { ok: false, state, message: state.error };
  }

  return { ok: true, state, message: `installing ${update.latest}` };
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
  // The replacement worker clears the marker its predecessor set, which is the only honest confirmation
  // that an install finished: the process that started it did not survive to report anything.
  if (state.upgradingTo && state.upgradingTo === deps.version) {
    state.upgradingTo = '';
    changed = true;
  }

  // A stored check was answered against whatever version was running when it ran. After an upgrade that
  // is the OLD version, so the banner would go on offering a release that is already installed until the
  // next daily check came round. Re-decide against the version actually running — same fetched `latest`,
  // no network call, so it costs nothing and cannot be skipped by the throttle.
  if (state.update && state.update.current !== deps.version) {
    const available = isNewer(state.update.latest, deps.version);
    state.update = {
      ...state.update,
      current: deps.version,
      available,
      note: available ? '' : 'up to date',
    };
    changed = true;
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
