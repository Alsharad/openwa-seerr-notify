import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginNetResponse } from './types/openwa';
import { probeSeerr } from './probe.ts';

const res = (status: number, body: unknown): PluginNetResponse => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: '',
  headers: {},
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const STATUS_OK = res(200, { version: '2.7.3', commitTag: 'local', restartRequired: false });

/** Route each probe request by path, so a test states only the outcomes it cares about. */
function fetcher(routes: { status?: () => Promise<PluginNetResponse>; user?: () => Promise<PluginNetResponse> }) {
  const urls: string[] = [];
  const fetch = async (url: string): Promise<PluginNetResponse> => {
    urls.push(url);
    if (url.includes('/api/v1/status')) return (routes.status ?? (async () => STATUS_OK))();
    if (url.includes('/api/v1/user')) return (routes.user ?? (async () => res(200, { results: [] })))();
    throw new Error(`unexpected url ${url}`);
  };
  return { fetch, urls };
}

const deps = (fetch: ReturnType<typeof fetcher>['fetch']) => ({
  fetch,
  baseUrl: 'http://seerr.example.test:5055',
  apiKey: 'key',
});

test('a reachable Seerr with a valid key reports its version', async () => {
  const { fetch } = fetcher({});
  const result = await probeSeerr(deps(fetch));
  assert.equal(result.ok, true);
  assert.equal(result.version, '2.7.3');
  assert.match(result.message, /Seerr 2\.7\.3 at http:\/\/seerr\.example\.test:5055/);
  assert.match(result.message, /API key accepted/);
});

test('the update check is suppressed so the probe cannot wait on GitHub', async () => {
  const { fetch, urls } = fetcher({});
  await probeSeerr(deps(fetch));
  const status = urls.find((u) => u.includes('/status'));
  // Literally 'false': Seerr 3.4.1 validates this query against its OpenAPI schema and answers 400 to
  // an empty value or '0'. Verified against a live 3.4.1 instance.
  assert.match(String(status), /checkUpdateAvailable=false$/);
});

test('an unreachable host names the two allowlists that usually cause it', async () => {
  const { fetch } = fetcher({
    status: async () => {
      throw new Error('host not allowed by plugin net.allow');
    },
  });
  const result = await probeSeerr(deps(fetch));
  assert.equal(result.ok, false);
  assert.match(result.message, /cannot reach/);
  assert.match(result.message, /net\.allow/);
  assert.match(result.message, /SSRF_ALLOWED_HOSTS/);
});

test('a rejected API key is reported separately from an unreachable host', async () => {
  const { fetch } = fetcher({ user: async () => res(403, { message: 'forbidden' }) });
  const result = await probeSeerr(deps(fetch));
  assert.equal(result.ok, false);
  assert.equal(result.version, '2.7.3');
  assert.match(result.message, /reachable/);
  assert.match(result.message, /API key was rejected \(HTTP 403\)/);
});

test('a URL that answers but is not Seerr is called out as the wrong URL', async () => {
  const { fetch } = fetcher({ status: async () => res(200, '<html>router login</html>') });
  const result = await probeSeerr(deps(fetch));
  assert.equal(result.ok, false);
  assert.match(result.message, /not with a Seerr status payload/);
});

test('a non-2xx status endpoint reports the HTTP code', async () => {
  const { fetch } = fetcher({ status: async () => res(502, {}) });
  const result = await probeSeerr(deps(fetch));
  assert.equal(result.ok, false);
  assert.match(result.message, /HTTP 502/);
});

test('missing settings are reported without any request going out', async () => {
  const { fetch, urls } = fetcher({});
  assert.match((await probeSeerr({ fetch, baseUrl: '', apiKey: 'k' })).message, /no Seerr URL/);
  assert.match((await probeSeerr({ fetch, baseUrl: 'http://x', apiKey: '' })).message, /no Seerr API key/);
  assert.deepEqual(urls, []);
});
