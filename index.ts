import type { IPlugin, PluginContext } from './types/openwa';
import { readConfig, readSeerrConnection } from './config.ts';
import { handleSeerrWebhook } from './handler.ts';
import { readDeadLetters } from './deadletter.ts';
import { probeSeerr } from './probe.ts';
import { API_KEY_FILE_CANDIDATES, refreshRoster } from './roster-refresh.ts';
import { parseSetupAction, readSetup, refreshSetupInBackground, runSetupAction } from './setup.ts';
import { writePluginConfig } from './gateway.ts';
import type { SetupRunDeps } from './setup.ts';
import { CHECK_INTERVAL_MS, repoSlug } from './update-check.ts';

// Baked from manifest.json at build time by package.mjs (esbuild `define`). The sandbox does not pass
// `manifest` into ctx, so this is how the plugin knows its own version at runtime. Falls back to a dev
// marker when run un-bundled (e.g. the test runner).
declare const __PLUGIN_VERSION__: string;
const PLUGIN_VERSION = typeof __PLUGIN_VERSION__ !== 'undefined' ? __PLUGIN_VERSION__ : '0.0.0-dev';

/** Baked from manifest.repository the same way, so the update check knows which repo to ask about. */
declare const __PLUGIN_REPO__: string;
const PLUGIN_REPO = typeof __PLUGIN_REPO__ !== 'undefined' ? __PLUGIN_REPO__ : '';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Persisted so a redelivered config change cannot re-run a refresh a previous worker already finished. */
const LAST_REFRESH_KEY = 'last-roster-refresh';
/** The same guard for the Setup tab's buttons. */
const LAST_SETUP_KEY = 'last-setup-action';

/**
 * How long after enable the background setup pass runs. Long enough that the gateway's own HTTP server
 * is accepting connections (this calls back into it over loopback), short enough that the Setup tab is
 * populated before an operator who just installed the plugin gets there.
 */
const BACKGROUND_SETUP_DELAY_MS = 10_000;
/** The same pass, when a panel is waiting on it to confirm an install finished. */
const INSTALL_REPORT_DELAY_MS = 1_500;

/**
 * Read the gateway's own admin key from the file it seeds on first run. `node:fs` is reachable because
 * the worker is crash containment rather than a security boundary — see the header of roster-refresh.ts
 * for why the in-dashboard refresh button accepts that, and what it deliberately does not do (the key is
 * never copied into config, and never leaves this process).
 */
async function readGatewayApiKey(): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const candidates = process.env.OPENWA_API_KEY_FILE
    ? [process.env.OPENWA_API_KEY_FILE, ...API_KEY_FILE_CANDIDATES]
    : API_KEY_FILE_CANDIDATES;

  for (const path of candidates) {
    try {
      const key = (await readFile(path, 'utf8')).trim();
      if (key) return key;
    } catch {
      // Try the next candidate; the message below names them all if none worked.
    }
  }
  throw new Error(`could not read the gateway API key (looked in: ${candidates.join(', ')})`);
}

/** The gateway talking to itself. Loopback, so it never leaves the container. */
function gatewaySelfUrl(): string {
  return process.env.OPENWA_SELF_URL ?? `http://127.0.0.1:${process.env.PORT ?? '2785'}`;
}

/**
 * Seerr Notifications.
 *
 * Claims the ingress route "seerr". The host verifies the shared-secret header (manifest
 * signature.scheme: 'shared-secret', secret = instance.secret) and runs the `session-alive` preflight
 * before dispatching, so Seerr gets synchronous feedback — 401 on a bad token, 503 on a dead session,
 * 200 application/json on accept — and this handler only ever sees authentic deliveries.
 *
 * The handler validates and returns; enrichment and sending run detached, because the host's ingress
 * dispatch budget is 5 s and a poster upload alone can outlast it (see handler.ts).
 */
export default class SeerrNotifyPlugin implements IPlugin {
  private ctx?: PluginContext;
  /** Guards against two refreshes overlapping when Save is clicked twice in quick succession. */
  private refreshing = false;
  /** The same, for the Setup tab's buttons — they write the same config from the same worker. */
  private settingUp = false;
  private backgroundTimer?: ReturnType<typeof setTimeout>;

  async onEnable(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;

    // A config with no recipients is reported, NOT thrown. Throwing here marks the plugin ERROR, and a
    // plugin in ERROR is never sent config changes (plugin-lifecycle gates sendConfigChange on ENABLED)
    // — which would strand a fresh install: the Setup tab and "Refresh from Seerr" are how an operator
    // GETS a first recipient, and both are driven by config changes. healthCheck still reports it.
    try {
      readConfig(ctx.config);
    } catch (err) {
      // The message already names the plugin, and the host prefixes every line with [seerr-notify].
      ctx.logger.warn(err instanceof Error ? err.message : String(err));
    }

    ctx.registerWebhook('seerr', async (req) => {
      // Re-read per delivery so dashboard edits (a new user, a toggled field) apply without a restart,
      // and so a per-session override resolves to the right slice.
      let config;
      try {
        config = readConfig(ctx.config);
      } catch (err) {
        // Nothing is deliverable, so there is nothing to dead-letter either — the recipient list is the
        // thing that is missing. The host has already ack'd Seerr; this only records why it stops here.
        ctx.logger.warn(`seerr-notify: dropping a delivery — ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      await handleSeerrWebhook(
        {
          config,
          net: (url, init) => ctx.net.fetch(url, init),
          send: (env) => ctx.conversations.send(env),
          storage: ctx.storage,
          log: (message, meta) => ctx.logger.warn(message, meta),
          sleep,
        },
        req,
      );
    });

    // Populate the Setup tab and check for a new release, a few seconds from now so the gateway's own
    // HTTP listener is up. Detached and failure-tolerant: neither is worth delaying enable for, and a
    // host with no reachable key file simply leaves the tab to its manual buttons.
    //
    // Unless this worker IS the result of an install: then somebody is watching a panel that says
    // "installing…", and the only thing that can tell them it finished is this pass writing the new
    // version and clearing the marker. Ten seconds of silence reads as a hang, so it runs as soon as the
    // gateway will answer.
    const finishingInstall = readSetup((ctx.config as Record<string, unknown>).setup).upgradingTo !== '';
    this.backgroundTimer = setTimeout(
      () => {
        void this.backgroundSetup(ctx);
      },
      finishingInstall ? INSTALL_REPORT_DELAY_MS : BACKGROUND_SETUP_DELAY_MS,
    );
    this.backgroundTimer.unref?.();

    ctx.logger.log(`seerr-notify enabled (v${PLUGIN_VERSION})`);
  }

  async onDisable(): Promise<void> {
    // The worker is terminated on disable, but an unfired timer that outlives the context would try to
    // write config for a plugin that is no longer running.
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    this.backgroundTimer = undefined;
  }

  /** The loopback + GitHub dependencies the Setup tab's work needs. */
  private setupDeps(ctx: PluginContext): SetupRunDeps {
    return {
      selfFetch: (target, init) => fetch(target, init as RequestInit),
      readApiKey: readGatewayApiKey,
      selfUrl: gatewaySelfUrl(),
      pluginId: ctx.pluginId,
      netFetch: (target, init) => ctx.net.fetch(target, init),
      repoSlug: repoSlug(PLUGIN_REPO),
      version: PLUGIN_VERSION,
    };
  }

  /**
   * The one thing here that happens without an operator asking: the ingress URL is read back and, at
   * most once a day, GitHub is asked whether there is a newer release. Both land in config for the
   * editor to render — the update banner cannot appear any other way, because the editor has no network.
   *
   * `updateCheckEnabled: false` switches off the GitHub half; the local instance read still runs, since
   * it never leaves the container.
   */
  private async backgroundSetup(ctx: PluginContext): Promise<void> {
    if (this.settingUp) return;
    this.settingUp = true;
    try {
      const config = ctx.config as Record<string, unknown>;
      const state = await refreshSetupInBackground(this.setupDeps(ctx), readSetup(config.setup), {
        checkUpdates: config.updateCheckEnabled !== false,
        intervalMs: CHECK_INTERVAL_MS,
      });
      if (state?.update?.available) {
        ctx.logger.warn(
          `seerr-notify: version ${state.update.latest} is available (running ${PLUGIN_VERSION}) — ${state.update.url}`,
        );
      }
    } catch (err) {
      ctx.logger.debug(`seerr-notify: background setup pass skipped — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.settingUp = false;
    }
  }

  /**
   * Drives every button in the editor that needs something fetched — "Refresh from Seerr" on the
   * Recipients tab, and all three on the Setup tab.
   *
   * None of them can fetch anything themselves: the editor is an opaque-origin sandbox whose document
   * carries `connect-src 'none'`, and whose only channel to the host speaks `config:get`/`config:save`.
   * So a button SAVES a changed token instead. That save lands here, the plugin does the work, and it
   * writes the result back into config for the editor to read on its next handshake.
   *
   * Each write fires this handler a second time carrying the same token, which is exactly what the
   * persisted markers are for: a token already processed does nothing, so the loop terminates.
   */
  async onConfigChange(ctx: PluginContext, newConfig: Record<string, unknown>): Promise<void> {
    this.ctx = ctx;
    await this.handleRosterToken(ctx, newConfig);
    await this.handleSetupToken(ctx, newConfig);
  }

  /** The Setup tab: read the ingress instances, rotate a secret, or check GitHub for a release. */
  private async handleSetupToken(ctx: PluginContext, newConfig: Record<string, unknown>): Promise<void> {
    const action = parseSetupAction(newConfig.setupRequestedAt);
    if (!action || this.settingUp) return;

    const seen = await ctx.storage.get<string>(LAST_SETUP_KEY).catch(() => null);
    if (seen === action.token) return; // our own write-back, or a redelivery — already handled

    this.settingUp = true;
    try {
      await ctx.storage.set(LAST_SETUP_KEY, action.token).catch(() => undefined);
      const previous = readSetup((ctx.config as Record<string, unknown>).setup);
      const result = await runSetupAction(this.setupDeps(ctx), previous, action);

      if (result.ok) ctx.logger.log(`seerr-notify: ${result.message}`);
      else ctx.logger.warn(`seerr-notify: setup action "${action.name}" failed — ${result.message}`);
    } catch (err) {
      ctx.logger.error('seerr-notify: setup action threw', err);
    } finally {
      this.settingUp = false;
    }
  }

  private async handleRosterToken(ctx: PluginContext, newConfig: Record<string, unknown>): Promise<void> {
    const token = typeof newConfig.rosterRefreshRequestedAt === 'string' ? newConfig.rosterRefreshRequestedAt : '';
    if (!token || this.refreshing) return;

    const seen = await ctx.storage.get<string>(LAST_REFRESH_KEY).catch(() => null);
    if (seen === token) return; // our own write-back, or a redelivery — already handled

    this.refreshing = true;
    try {
      // Recorded BEFORE the work, not after: a crash mid-refresh must not leave a token that replays on
      // every subsequent config change. The operator can always click the button again.
      await ctx.storage.set(LAST_REFRESH_KEY, token).catch(() => undefined);

      const url = String(newConfig.jellyseerrUrl ?? '').trim().replace(/\/+$/, '');
      // Read from ctx.config, not newConfig: the dashboard sends secrets back masked ('***'), and the
      // host restores the real value into ctx.config before this fires.
      const apiKey = String((ctx.config as Record<string, unknown>).jellyseerrApiKey ?? '').trim();

      const result = await refreshRoster(
        {
          seerrFetch: (target, init) => ctx.net.fetch(target, init),
          selfFetch: (target, init) => fetch(target, init as RequestInit),
          readApiKey: readGatewayApiKey,
          selfUrl: gatewaySelfUrl(),
          pluginId: ctx.pluginId,
          log: (message, meta) => ctx.logger.warn(message, meta),
        },
        { url, apiKey },
        token,
      );

      if (result.ok) ctx.logger.log(`seerr-notify: ${result.message}`);
      else ctx.logger.warn(`seerr-notify: roster refresh failed — ${result.message}`);

      // Record the outcome the way every other button records it, so the editor has ONE landing signal
      // to wait on rather than a special case per button — and so a failed refresh reports its reason in
      // the panel instead of only in the gateway log.
      const previous = readSetup((ctx.config as Record<string, unknown>).setup);
      await writePluginConfig(
        {
          selfFetch: (target, init) => fetch(target, init as RequestInit),
          readApiKey: readGatewayApiKey,
          selfUrl: gatewaySelfUrl(),
          pluginId: ctx.pluginId,
        },
        { setup: { ...previous, lastAction: `roster|${token}`, error: result.ok ? '' : result.message } },
      ).catch((err) => ctx.logger.warn(`seerr-notify: could not record the refresh outcome — ${String(err)}`));
    } catch (err) {
      ctx.logger.error('seerr-notify: roster refresh threw', err);
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Doubles as the "test my Seerr settings" button: the dashboard's health-check action calls
   * `GET /api/plugins/seerr-notify/health` and shows `message` in a toast.
   *
   * The verdict tracks the CONFIGURATION, not the delivery history. A bad URL or a rejected API key is
   * something the operator must fix, so it reports unhealthy. Dead letters are appended as context but
   * never flip the verdict — one failed send is not a broken plugin, and a health badge that flaps on
   * every hiccup stops being a signal.
   */
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (!this.ctx) return { healthy: true, message: 'not enabled' };
    const ctx = this.ctx;

    const notes: string[] = [];
    let healthy = true;

    // The Seerr connection is probed FIRST and independently of the recipient list. readConfig refuses a
    // config with nobody mapped, and on a fresh install that is the normal state — but this button is
    // also "test my Seerr settings", and refusing to test them until a recipient exists inverts the order
    // an operator actually works in (connect Seerr, fetch the roster, map someone).
    const seerr = readSeerrConnection(ctx.config);
    if (!seerr.enabled) {
      // Unhealthy, not a note: since 1.8.0 the connection is what the recipient list is built from, so an
      // install without one cannot notify anybody. Reporting it as a degraded-but-fine state was left
      // over from when enrichment was optional.
      healthy = false;
      notes.push('no Seerr URL/API key configured — open Configure > Connection and fill both in');
    } else {
      const probe = await probeSeerr({
        fetch: (url, init) => ctx.net.fetch(url, init),
        baseUrl: seerr.url,
        apiKey: seerr.apiKey,
      });
      notes.push(probe.message);
      if (!probe.ok) healthy = false;
    }

    try {
      readConfig(ctx.config);
    } catch (err) {
      // readConfig throws only when the plugin could not deliver anything at all (no user mapping).
      healthy = false;
      notes.push(err instanceof Error ? err.message : String(err));
    }

    try {
      const deadLetters = await readDeadLetters({ storage: ctx.storage });
      if (deadLetters.length > 0) {
        const newest = deadLetters[0];
        notes.push(`${deadLetters.length} recent delivery failure(s), latest: ${newest.reason} at ${newest.at}`);
      }
    } catch (err) {
      notes.push(`could not read the failure buffer: ${err instanceof Error ? err.message : String(err)}`);
    }

    return { healthy, message: notes.join('; ') };
  }
}
