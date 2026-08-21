import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginNetResponse } from './types/openwa';
import { EMPTY_SETUP, parseSetupAction, readSetup, refreshSetupInBackground, runSetupAction } from './setup.ts';
import type { SetupRunDeps } from './setup.ts';

const NOW = () => new Date('2026-08-21T12:00:00.000Z');

/** One row as the gateway's InstanceView serializes it. */
const instanceRow = (instanceId: string, url: string, extra: Record<string, unknown> = {}) => ({
  id: `seerr-notify:${instanceId}`,
  pluginId: 'seerr-notify',
  instanceId,
  sessionScope: null,
  secret: '***',
  enabled: true,
  ingressUrls: [{ route: 'seerr', url }],
  ...extra,
});

interface Call {
  url: string;
  method: string;
  key?: string;
  body?: unknown;
}

function harness(routes: Record<string, { status?: number; body?: unknown }> = {}) {
  const calls: Call[] = [];
  const deps: SetupRunDeps = {
    selfFetch: async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        key: (init?.headers as Record<string, string> | undefined)?.['X-API-Key'],
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const path = url.replace('http://127.0.0.1:2785', '');
      const route = routes[`${method} ${path}`] ?? routes[path] ?? { status: 200, body: {} };
      const status = route.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {})),
      };
    },
    readApiKey: async () => 'owa_k1_test',
    selfUrl: 'http://127.0.0.1:2785',
    pluginId: 'seerr-notify',
    netFetch: async (): Promise<PluginNetResponse> => ({
      ok: true,
      status: 200,
      statusText: '',
      headers: {},
      body: JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://github.com/o/r/releases/tag/v9.9.9' }),
    }),
    repoSlug: 'o/r',
    version: '1.6.0',
    runTest: async () => ({ ok: true, message: 'test message sent to 1 recipient(s): ***0001@c.us' }),
    now: NOW,
  };
  return { deps, calls, written: () => calls.filter((c) => c.url.endsWith('/api/plugins/seerr-notify/config')) };
}

test('only the two known actions parse', () => {
  assert.deepEqual(parseSetupAction('update||2026-08-21T12:00:00.000Z'), {
    name: 'update',
    arg: '',
    token: 'update||2026-08-21T12:00:00.000Z',
  });
  assert.equal(parseSetupAction('upgrade||t')?.name, 'upgrade');

  assert.equal(parseSetupAction(''), null);
  assert.equal(parseSetupAction(undefined), null);
  assert.equal(parseSetupAction(42), null);
  // An action a newer editor might introduce must do nothing rather than something arbitrary — and the
  // two that were retired must not come back to life through a config written by an older one.
  assert.equal(parseSetupAction('uninstall||t'), null);
  assert.equal(parseSetupAction('instances||t'), null, 'the Instances tab owns this now');
  assert.equal(parseSetupAction('secret|seerr-prod|t'), null, 'so does regenerating a secret');
});

test('a malformed stored setup reads back as the empty state rather than throwing', () => {
  assert.deepEqual(readSetup(undefined), EMPTY_SETUP);
  assert.deepEqual(readSetup('nonsense'), EMPTY_SETUP);
  assert.deepEqual(readSetup({ version: 7 }), EMPTY_SETUP);
  assert.equal(readSetup({ version: '1.2.3' }).version, '1.2.3');
});

test('an install writes what it is doing BEFORE it replaces the worker doing it', async () => {
  // POST /plugins/:id/update unloads this very plugin, so a success never gets to report itself. The
  // state — including the token the editor is waiting on — has to be on disk before the call goes out.
  const order: string[] = [];
  const { deps } = harness({
    'GET https://api.github.com': {},
    '/api/plugins/seerr-notify/config': {},
    'POST /api/plugins/seerr-notify/update': { body: { version: '1.9.9' } },
  });
  const wrapped: SetupRunDeps = {
    ...deps,
    selfFetch: async (url, init) => {
      order.push(`${init?.method ?? 'GET'} ${url.replace('http://127.0.0.1:2785', '')}`);
      return deps.selfFetch(url, init);
    },
  };

  const state = {
    ...EMPTY_SETUP,
    update: {
      current: '1.6.0',
      latest: '1.9.9',
      url: 'https://github.com/o/r/releases/tag/v1.9.9',
      checkedAt: '2026-08-21T12:00:00.000Z',
      available: true,
      note: '',
      asset: 'https://github.com/o/r/releases/download/v1.9.9/seerr-notify.zip',
      sha256: 'f'.repeat(64),
    },
  };

  const result = await runSetupAction(wrapped, state, parseSetupAction('upgrade||t9')!);
  assert.equal(result.ok, true);
  assert.equal(result.message, 'installing 1.9.9');
  assert.deepEqual(order, [
    'PUT /api/plugins/seerr-notify/config',
    'POST /api/plugins/seerr-notify/update',
  ], 'the record must be written first — afterwards there is no worker left to write it');
});

test('an install is refused rather than run unpinned', async () => {
  const { deps } = harness();
  const noChecksum = {
    ...EMPTY_SETUP,
    update: {
      current: '1.6.0', latest: '1.9.9', url: 'u', checkedAt: '', available: true, note: '',
      asset: 'https://github.com/o/r/releases/download/v1.9.9/seerr-notify.zip',
      sha256: '',
    },
  };
  const result = await runSetupAction(deps, noChecksum, parseSetupAction('upgrade||t10')!);
  assert.equal(result.ok, false);
  assert.match(result.message, /cannot be pinned/);
});

test('an install with nothing newer to install says so', async () => {
  const { deps } = harness();
  const result = await runSetupAction(deps, EMPTY_SETUP, parseSetupAction('upgrade||t11')!);
  assert.equal(result.ok, false);
  assert.match(result.message, /no newer release/);
});

test('an upgrade clears the banner without waiting for the next daily check', async () => {
  // The stored check was answered against the version running at the time. After an in-place upgrade
  // that is the OLD version, so the banner would keep offering a release already installed — "1.10.1 is
  // available (running 1.10.1)" — until the daily throttle let another check through.
  const { deps, written } = harness({
    '/api/integration/plugins/seerr-notify/instances': { body: [] },
  });
  const justUpgraded = {
    ...EMPTY_SETUP,
    version: '1.5.0',
    upgradingTo: '1.6.0',
    update: {
      current: '1.5.0', latest: '1.6.0', url: 'u', checkedAt: '2026-08-21T11:59:00.000Z',
      available: true, note: '', asset: 'a', sha256: 'b'.repeat(64),
    },
  };

  // Inside the throttle window, so no network check runs — this has to be decided locally.
  const state = await refreshSetupInBackground(deps, justUpgraded, { checkUpdates: true, intervalMs: 24 * 60 * 60 * 1000 });
  assert.equal(state?.update?.available, false, 'the release the plugin is now running is not an update');
  assert.equal(state?.update?.current, '1.6.0');
  assert.equal(state?.update?.note, 'up to date');
  assert.equal(state?.update?.latest, '1.6.0', 'the fetched result is re-decided, not discarded');
  assert.equal(state?.upgradingTo, '', 'and the install marker is cleared');
  assert.equal(written().length, 1);
});

test('the pre-1.13 config key names still resolve', async () => {
  // `jellyseerrUrl` / `jellyseerrApiKey` were renamed to `seerrUrl` / `seerrApiKey`. Reading both is what
  // keeps an install working between the version that renames them and the pass that migrates it — a
  // rename that silently disconnects everyone's Seerr server is not a rename, it is an outage.
  const { readSeerrConnection } = await import('./config.ts');

  const old = readSeerrConnection({ jellyseerrUrl: 'http://seerr:5055/', jellyseerrApiKey: 'k' });
  assert.equal(old.url, 'http://seerr:5055');
  assert.equal(old.apiKey, 'k');
  assert.equal(old.enabled, true);

  const migrated = readSeerrConnection({ seerrUrl: 'http://new:5055', seerrApiKey: 'n' });
  assert.equal(migrated.url, 'http://new:5055');
  assert.equal(migrated.apiKey, 'n');

  // Mid-migration both are present; the new spelling is the one that counts.
  const both = readSeerrConnection({
    seerrUrl: 'http://new:5055',
    seerrApiKey: 'n',
    jellyseerrUrl: 'http://old:5055',
    jellyseerrApiKey: 'o',
  });
  assert.equal(both.url, 'http://new:5055');
  assert.equal(both.apiKey, 'n');
});
