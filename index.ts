import type { IPlugin, PluginContext } from './types/openwa';
import { readConfig } from './config.ts';
import { handleSeerrWebhook } from './handler.ts';
import { readDeadLetters } from './deadletter.ts';
import { probeSeerr } from './probe.ts';
import { API_KEY_FILE_CANDIDATES, refreshRoster } from './roster-refresh.ts';

// Baked from manifest.json at build time by package.mjs (esbuild `define`). The sandbox does not pass
// `manifest` into ctx, so this is how the plugin knows its own version at runtime. Falls back to a dev
// marker when run un-bundled (e.g. the test runner).
declare const __PLUGIN_VERSION__: string;
const PLUGIN_VERSION = typeof __PLUGIN_VERSION__ !== 'undefined' ? __PLUGIN_VERSION__ : '0.0.0-dev';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Persisted so a redelivered config change cannot re-run a refresh a previous worker already finished. */
const LAST_REFRESH_KEY = 'last-roster-refresh';

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

  async onEnable(ctx: PluginContext): Promise<void> {
    this.ctx = ctx;

    // Fail fast on the base config so a missing user mapping shows up in the dashboard at enable time
    // rather than once per webhook. Per-instance config is re-read per delivery below.
    readConfig(ctx.config);

    ctx.registerWebhook('seerr', async (req) => {
      // Re-read per delivery so dashboard edits (a new user, a toggled field) apply without a restart,
      // and so a per-session override resolves to the right slice.
      const config = readConfig(ctx.config);
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

    ctx.logger.log(`seerr-notify enabled (v${PLUGIN_VERSION})`);
  }

  /**
   * Drives the Recipients tab's "Refresh from Seerr" button.
   *
   * The editor cannot fetch anything itself, so the button works by SAVING a changed
   * `rosterRefreshRequestedAt` token. That save lands here, and this fetches the roster and writes it
   * back — see roster-refresh.ts for why a plugin writing its own config needs the gateway admin key.
   *
   * The write fires this handler a second time carrying the same token, which is exactly what the
   * persisted marker below is for: a token already processed does nothing, so the loop terminates.
   */
  async onConfigChange(ctx: PluginContext, newConfig: Record<string, unknown>): Promise<void> {
    this.ctx = ctx;

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

    try {
      const config = readConfig(ctx.config);

      if (!config.jellyseerr.enabled) {
        notes.push(
          config.jellyseerrConfigured
            ? 'Seerr enrichment is switched off; notifications send without media detail'
            : 'no Seerr URL/API key configured; notifications send without media detail',
        );
      } else {
        const probe = await probeSeerr({
          fetch: (url, init) => ctx.net.fetch(url, init),
          baseUrl: config.jellyseerr.url,
          apiKey: config.jellyseerr.apiKey,
        });
        notes.push(probe.message);
        if (!probe.ok) healthy = false;
      }
    } catch (err) {
      // readConfig throws only when the plugin could not deliver anything at all (no user mapping).
      return { healthy: false, message: err instanceof Error ? err.message : String(err) };
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
