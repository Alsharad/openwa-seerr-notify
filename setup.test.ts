import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginNetResponse } from './types/openwa';
import {
  EMPTY_SETUP,
  discoverInstances,
  parseSetupAction,
  readSetup,
  refreshSetupInBackground,
  rotateSecret,
  runSetupAction,
} from './setup.ts';
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
    now: NOW,
  };
  return { deps, calls, written: () => calls.filter((c) => c.url.endsWith('/api/plugins/seerr-notify/config')) };
}

test('only the three known actions parse, and a secret action must name a legal instance', () => {
  assert.deepEqual(parseSetupAction('instances||2026-08-21T12:00:00.000Z'), {
    name: 'instances',
    arg: '',
    token: 'instances||2026-08-21T12:00:00.000Z',
  });
  assert.equal(parseSetupAction('secret|seerr-prod|t')?.arg, 'seerr-prod');
  assert.equal(parseSetupAction('update||t')?.name, 'update');

  assert.equal(parseSetupAction(''), null);
  assert.equal(parseSetupAction(undefined), null);
  assert.equal(parseSetupAction(42), null);
  // An action a newer editor might introduce must do nothing rather than something arbitrary.
  assert.equal(parseSetupAction('uninstall||t'), null);
  // The instance id goes into a URL path; the gateway's own pattern is the one enforced here.
  assert.equal(parseSetupAction('secret||t'), null, 'a secret action with no instance is not runnable');
  assert.equal(parseSetupAction('secret|../../etc|t'), null, 'a path-traversing instance id is rejected');
});

test('a malformed stored setup reads back as the empty state rather than throwing', () => {
  assert.deepEqual(readSetup(undefined), EMPTY_SETUP);
  assert.deepEqual(readSetup('nonsense'), EMPTY_SETUP);
  assert.deepEqual(readSetup({ instances: 'not an array', secret: 7 }), EMPTY_SETUP);
  assert.equal(readSetup({ secret: 'abc' }).secret, 'abc');
});

test('instance discovery keeps the ingress URL and flags a relative one', async () => {
  const { deps, calls } = harness({
    '/api/integration/plugins/seerr-notify/instances': {
      body: [
        instanceRow('seerr-prod', 'http://192.168.1.8:2785/api/ingress/seerr-notify/seerr-prod/seerr'),
        instanceRow('seerr-dev', '/api/ingress/seerr-notify/seerr-dev/seerr', { sessionScope: 'sess-1', enabled: false }),
      ],
    },
  });

  const instances = await discoverInstances(deps);
  assert.equal(calls[0].key, 'owa_k1_test');
  assert.deepEqual(instances, [
    {
      instanceId: 'seerr-prod',
      sessionScope: '',
      enabled: true,
      url: 'http://192.168.1.8:2785/api/ingress/seerr-notify/seerr-prod/seerr',
      relative: false,
    },
    {
      instanceId: 'seerr-dev',
      sessionScope: 'sess-1',
      enabled: false,
      // buildIngressUrls returns a path when BASE_URL is unset; the editor prefixes it with a placeholder
      // host rather than guessing one, so the operator cannot paste a URL that silently never connects.
      url: '/api/ingress/seerr-notify/seerr-dev/seerr',
      relative: true,
    },
  ]);
});

test('rotating a secret returns the plaintext the gateway reveals exactly once', async () => {
  const { deps, calls } = harness({
    'POST /api/integration/plugins/seerr-notify/instances/seerr-prod/regenerate-secret': {
      body: { instanceId: 'seerr-prod', secret: 'f4c6918f6789215834292b55ec4e69d3' },
    },
  });

  assert.equal(await rotateSecret(deps, 'seerr-prod'), 'f4c6918f6789215834292b55ec4e69d3');
  assert.equal(calls[0].method, 'POST');
});

test('a masked secret is treated as a failure, not stored as the secret', async () => {
  // Every read but the mint answers '***'. Writing that into config would leave the operator pasting
  // three asterisks into Seerr and wondering why every delivery 401s.
  const { deps } = harness({
    'POST /api/integration/plugins/seerr-notify/instances/seerr-prod/regenerate-secret': { body: { secret: '***' } },
  });
  await assert.rejects(() => rotateSecret(deps, 'seerr-prod'), /did not reveal/);
});

test('a missing instance is reported by name', async () => {
  const { deps } = harness({
    'POST /api/integration/plugins/seerr-notify/instances/nope/regenerate-secret': { status: 404 },
  });
  await assert.rejects(() => rotateSecret(deps, 'nope'), /no ingress instance called "nope"/);
});

test('a completed action writes the result back and CLEARS its own token', async () => {
  const { deps, written } = harness({
    '/api/integration/plugins/seerr-notify/instances': {
      body: [instanceRow('seerr-prod', 'http://host:2785/api/ingress/seerr-notify/seerr-prod/seerr')],
    },
  });

  const result = await runSetupAction(deps, EMPTY_SETUP, parseSetupAction('instances||t1')!);
  assert.equal(result.ok, true);
  assert.equal(result.message, 'found 1 ingress instance(s)');

  const body = written()[0].body as { config: Record<string, unknown> };
  assert.deepEqual(Object.keys(body.config).sort(), ['setup', 'setupRequestedAt']);
  // Cleared, not echoed: a stale `secret|…` token surviving in config would rotate the secret again on
  // an unrelated restart and silently 401 Seerr. `lastAction` is what the editor reads instead.
  assert.equal(body.config.setupRequestedAt, '');
  assert.equal((body.config.setup as { lastAction: string }).lastAction, 'instances||t1');
});

test('an action replaces only what it owns', async () => {
  const { deps, written } = harness({
    '/api/integration/plugins/seerr-notify/instances': {
      body: [instanceRow('seerr-prod', 'http://host:2785/api/ingress/seerr-notify/seerr-prod/seerr')],
    },
  });

  const previous = {
    ...EMPTY_SETUP,
    secret: 'kept',
    secretFor: 'seerr-prod',
    update: { current: '1.6.0', latest: '1.7.0', url: 'u', checkedAt: 'earlier', available: true, note: '', asset: '', sha256: '' },
  };
  await runSetupAction(deps, previous, parseSetupAction('instances||t2')!);

  const state = (written()[0].body as { config: { setup: Record<string, unknown> } }).config.setup;
  assert.equal(state.secret, 'kept', 'reading the instance list must not blank the secret');
  assert.deepEqual(state.update, previous.update, 'nor the update banner');
});

test('a failing action still writes, so the reason reaches the editor', async () => {
  const { deps, written } = harness({ '/api/integration/plugins/seerr-notify/instances': { status: 503 } });

  const result = await runSetupAction(deps, EMPTY_SETUP, parseSetupAction('instances||t3')!);
  assert.equal(result.ok, false);
  assert.match(result.message, /HTTP 503/);

  const state = (written()[0].body as { config: { setup: { error: string } } }).config.setup;
  assert.match(state.error, /HTTP 503/, 'an operator staring at a dead button deserves the reason in the editor');
});

test('rotating also refreshes the URL list, but a failure to list does not lose the secret', async () => {
  const { deps, written } = harness({
    'POST /api/integration/plugins/seerr-notify/instances/seerr-prod/regenerate-secret': { body: { secret: 'newsecret' } },
    '/api/integration/plugins/seerr-notify/instances': { status: 500 },
  });

  const result = await runSetupAction(deps, EMPTY_SETUP, parseSetupAction('secret|seerr-prod|t4')!);
  assert.equal(result.ok, true);

  const state = (written()[0].body as { config: { setup: Record<string, unknown> } }).config.setup;
  assert.equal(state.secret, 'newsecret');
  assert.equal(state.secretFor, 'seerr-prod');
  assert.equal(state.secretAt, '2026-08-21T12:00:00.000Z');
});

test('the background pass checks GitHub at most once per interval', async () => {
  const { deps, written } = harness({
    '/api/integration/plugins/seerr-notify/instances': {
      body: [instanceRow('seerr-prod', 'http://host:2785/api/ingress/seerr-notify/seerr-prod/seerr')],
    },
  });
  const day = 24 * 60 * 60 * 1000;

  const first = await refreshSetupInBackground(deps, EMPTY_SETUP, { checkUpdates: true, intervalMs: day });
  assert.equal(first?.update?.available, true, 'v9.9.9 against 1.6.0');

  // Checked a minute ago: the instance read still runs (it never leaves the container), GitHub does not.
  const recent = { ...first!, update: { ...first!.update!, checkedAt: '2026-08-21T11:59:00.000Z' } };
  const second = await refreshSetupInBackground(deps, recent, { checkUpdates: true, intervalMs: day });
  assert.equal(second?.update?.checkedAt, '2026-08-21T11:59:00.000Z', 'the old check is kept, not redone');

  const third = await refreshSetupInBackground(deps, EMPTY_SETUP, { checkUpdates: false, intervalMs: day });
  assert.equal(third?.update, null, 'switched off means no outbound request at all');

  assert.equal(written().length, 3);
});

test('the background pass writes nothing when it has nothing', async () => {
  // No key file, no gateway, no update check — an install where the loopback write is unavailable must
  // not write an empty state over whatever the operator already has. `version` already matches, so
  // there is genuinely nothing new to record.
  const { deps, written } = harness({ '/api/integration/plugins/seerr-notify/instances': { status: 401 } });
  const current = { ...EMPTY_SETUP, version: '1.6.0' };
  const state = await refreshSetupInBackground(deps, current, { checkUpdates: false, intervalMs: 1 });
  assert.equal(state, null);
  assert.equal(written().length, 0);
});

test('a version that has moved is written on its own', async () => {
  // How the panel reports the running build after an upgrade, without waiting for a release check that
  // may be switched off — or a gateway that may not answer.
  const { deps, written } = harness({ '/api/integration/plugins/seerr-notify/instances': { status: 401 } });
  const stale = { ...EMPTY_SETUP, version: '1.5.0' };
  const state = await refreshSetupInBackground(deps, stale, { checkUpdates: false, intervalMs: 1 });
  assert.equal(state?.version, '1.6.0');
  assert.equal(written().length, 1);
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
