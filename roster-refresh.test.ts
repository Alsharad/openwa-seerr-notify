import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginNetResponse } from './types/openwa';
import { fetchSeerrRoster, refreshRoster } from './roster-refresh.ts';
import type { RefreshDeps } from './roster-refresh.ts';

const SEERR = 'http://seerr.example.test:5055';

const page = (records: unknown[], total: number): PluginNetResponse => ({
  ok: true,
  status: 200,
  statusText: '',
  headers: {},
  body: JSON.stringify({ results: records, pageInfo: { results: total } }),
});

const user = (id: number, permissions = 4194464) => ({ id, displayName: `user${id}`, email: `u${id}@ex.com`, permissions });

function harness(overrides: Partial<RefreshDeps> = {}) {
  const written: Array<{ url: string; body: unknown; key?: string }> = [];
  const deps: RefreshDeps = {
    seerrFetch: async () => page([user(1, 2), user(11)], 2),
    selfFetch: async (url, init) => {
      written.push({
        url,
        body: JSON.parse(String(init?.body ?? '{}')),
        key: (init?.headers as Record<string, string> | undefined)?.['X-API-Key'],
      });
      return { ok: true, status: 200, text: async () => '' };
    },
    readApiKey: async () => 'owa_k1_test',
    selfUrl: 'http://127.0.0.1:2785',
    pluginId: 'seerr-notify',
    log: () => {},
    ...overrides,
  };
  return { deps, written };
}

test('a refresh fetches the roster and writes only the roster keys back', async () => {
  const { deps, written } = harness();
  const result = await refreshRoster(deps, { url: SEERR, apiKey: 'seerr-key' }, 'token-1');

  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(result.admins, 1);
  assert.equal(written.length, 1);
  assert.equal(written[0].url, 'http://127.0.0.1:2785/api/plugins/seerr-notify/config');
  assert.equal(written[0].key, 'owa_k1_test');

  const body = written[0].body as { config: Record<string, unknown> };
  // The host merges config shallowly, so a partial write cannot clobber the operator's other settings —
  // in particular the Seerr API key, which this path never reads or rewrites.
  assert.deepEqual(Object.keys(body.config).sort(), ['rosterRefreshRequestedAt', 'rosterSyncedAt', 'seerrRoster']);
  assert.equal(body.config.rosterRefreshRequestedAt, 'token-1', 'echoes the token so the write cannot loop');
  assert.deepEqual((body.config.seerrRoster as Array<{ id: number; isAdmin: boolean }>).map((e) => [e.id, e.isAdmin]), [
    [1, true],
    [11, false],
  ]);
});

test('missing Seerr settings are reported without touching the gateway', async () => {
  const { deps, written } = harness();
  const result = await refreshRoster(deps, { url: '', apiKey: 'k' }, 't');
  assert.equal(result.ok, false);
  assert.match(result.message, /must be configured/);
  assert.deepEqual(written, []);
});

test('a Seerr failure is reported and nothing is written', async () => {
  const { deps, written } = harness({
    seerrFetch: async () => ({ ok: false, status: 401, statusText: '', headers: {}, body: '' }),
  });
  const result = await refreshRoster(deps, { url: SEERR, apiKey: 'bad' }, 't');
  assert.equal(result.ok, false);
  assert.match(result.message, /HTTP 401/);
  assert.deepEqual(written, []);
});

test('an unreadable gateway key is reported before any write is attempted', async () => {
  const { deps, written } = harness({
    readApiKey: async () => {
      throw new Error('could not read the gateway API key (looked in: /app/data/.api-key)');
    },
  });
  const result = await refreshRoster(deps, { url: SEERR, apiKey: 'k' }, 't');
  assert.equal(result.ok, false);
  assert.match(result.message, /could not read the gateway API key/);
  assert.deepEqual(written, []);
});

test('a rejected config write is surfaced rather than reported as success', async () => {
  const { deps } = harness({
    selfFetch: async () => ({ ok: false, status: 403, text: async () => 'forbidden' }),
  });
  const result = await refreshRoster(deps, { url: SEERR, apiKey: 'k' }, 't');
  assert.equal(result.ok, false);
  assert.match(result.message, /HTTP 403/);
});

test('paging keeps fetching until the page is short, so a large install is not truncated', async () => {
  const total = 250;
  const requested: string[] = [];
  const roster = await fetchSeerrRoster(
    async (url) => {
      requested.push(url);
      const skip = Number(new URL(url).searchParams.get('skip'));
      const slice = Array.from({ length: Math.max(0, Math.min(100, total - skip)) }, (_, i) => user(skip + i + 1));
      return page(slice, total);
    },
    SEERR,
    'k',
  );

  assert.equal(roster.length, total);
  assert.equal(requested.length, 3);
  assert.match(requested[1], /skip=100/);
});

test('the roster comes back sorted by id, so the editor list is stable between refreshes', async () => {
  const roster = await fetchSeerrRoster(async () => page([user(11), user(2), user(1, 2)], 3), SEERR, 'k');
  assert.deepEqual(roster.map((e) => e.id), [1, 2, 11]);
});
