import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
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
  // Just the version. The dashboard renders its own success icon and title, so the message carries the
  // one fact that toast cannot — not the verdict, and not the address the operator just typed in.
  assert.equal(result.message, 'Seerr v2.7.3');
});

test('the update check is suppressed so the probe cannot wait on GitHub', async () => {
  const { fetch, urls } = fetcher({});
  await probeSeerr(deps(fetch));
  const status = urls.find((u) => u.includes('/status'));
  // Literally 'false': Seerr 3.4.1 validates this query against its OpenAPI schema and answers 400 to
  // an empty value or '0'. Verified against a live 3.4.1 instance.
  assert.match(String(status), /checkUpdateAvailable=false$/);
});

test('an unreachable host names the address and the reason', async () => {
  const { fetch } = fetcher({
    status: async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.9:5055');
    },
  });
  const result = await probeSeerr(deps(fetch));
  assert.equal(result.ok, false);
  assert.match(result.message, /Cannot reach http:\/\/seerr\.example\.test:5055/);
  assert.match(result.message, /ECONNREFUSED/);
  // net.allow stopped being advice when the manifest went to ['*'] in 1.9.0. Asserted against the source,
  // not the message: a stubbed error is free to mention anything, and here one did.
  const source = readFileSync(join(HERE, 'probe.ts'), 'utf8');
  assert.doesNotMatch(source, /net\.allow/, 'the probe must not send operators to edit a manifest allow-list');
});

test('a private address blocked by the SSRF guard gets the variable and the value', async () => {
  // The likeliest first-run failure there is: a self-hosted Seerr is nearly always on a LAN, and OpenWA
  // refuses private addresses until the operator opts in. The guard says "Blocked internal address:
  // 192.168.8.25", which states the rule and not the remedy — and after "Cannot reach <url>" it also
  // said the address twice.
  const { fetch } = fetcher({
    status: async () => {
      throw new Error('Blocked internal address: 192.168.8.25');
    },
  });
  const result = await probeSeerr({ fetch, baseUrl: 'http://192.168.8.25:5055', apiKey: 'k' });

  assert.equal(result.ok, false);
  assert.match(result.message, /SSRF_ALLOWED_HOSTS=192\.168\.8\.25/, 'name the variable and the value to set');
  assert.match(result.message, /restart/, 'an env var needs a restart to take effect');
  // The address once, in the sentence that needs it — not again as the guard's own wording.
  assert.doesNotMatch(result.message, /Blocked internal address/);
});

test('a hostname that resolves to a private address is treated the same way', async () => {
  // The guard's other wording. SSRF_ALLOWED_HOSTS matches on the URL hostname, so that is what to name —
  // not the address it resolved to.
  const { fetch } = fetcher({
    status: async () => {
      throw new Error('Host seerr.lan resolves to a blocked internal address: 10.1.2.3');
    },
  });
  const result = await probeSeerr({ fetch, baseUrl: 'http://seerr.lan:5055', apiKey: 'k' });
  assert.match(result.message, /SSRF_ALLOWED_HOSTS=seerr\.lan/);
});

test('a rejected API key is reported separately from an unreachable host', async () => {
  const { fetch } = fetcher({ user: async () => res(403, { message: 'forbidden' }) });
  const result = await probeSeerr(deps(fetch));
  assert.equal(result.ok, false);
  assert.equal(result.version, '2.7.3');
  assert.match(result.message, /reachable/);
  assert.match(result.message, /Seerr v2\.7\.3 reachable, but the API key was rejected\./);
});

test('a URL that answers but is not Seerr says so', async () => {
  const { fetch } = fetcher({ status: async () => res(200, '<html>router login</html>') });
  const result = await probeSeerr(deps(fetch));
  assert.equal(result.ok, false);
  assert.match(result.message, /it is not a Seerr server/);
});

test('a non-2xx status endpoint reports the HTTP code', async () => {
  const { fetch } = fetcher({ status: async () => res(502, {}) });
  const result = await probeSeerr(deps(fetch));
  assert.equal(result.ok, false);
  assert.match(result.message, /HTTP 502/);
});

test('missing settings are reported without any request going out', async () => {
  const { fetch, urls } = fetcher({});
  // Each names the field to fill and the tab it is on, rather than restating the absence.
  assert.match((await probeSeerr({ fetch, baseUrl: '', apiKey: 'k' })).message, /Add your Seerr address on the Connection tab\./);
  assert.match((await probeSeerr({ fetch, baseUrl: 'http://x', apiKey: '' })).message, /Add your Seerr API key on the Connection tab\./);
  assert.deepEqual(urls, []);
});
