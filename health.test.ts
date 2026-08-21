// What the health badge means. It has changed twice, so it is asserted here rather than left to a comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import SeerrNotifyPlugin from './index.ts';
import type { PluginContext, PluginNetResponse } from './types/openwa';

const seerrOk = async (url: string): Promise<PluginNetResponse> => ({
  ok: true,
  status: 200,
  statusText: '',
  headers: {},
  body: url.includes('/status') ? JSON.stringify({ version: '3.4.1' }) : JSON.stringify({ results: [] }),
});

/** Enough context for onEnable and healthCheck; every capability the delivery path needs is unused here. */
function contextWith(config: Record<string, unknown>, fetchFn = seerrOk): PluginContext {
  return {
    pluginId: 'seerr-notify',
    config,
    logger: { log() {}, debug() {}, warn() {}, error() {} },
    storage: { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] },
    net: { fetch: fetchFn },
    conversations: { send: async () => ({ ok: true }) },
    registerWebhook() {},
  } as unknown as PluginContext;
}

async function healthOf(config: Record<string, unknown>, fetchFn = seerrOk) {
  const plugin = new SeerrNotifyPlugin();
  await plugin.onEnable(contextWith(config, fetchFn));
  try {
    return await plugin.healthCheck();
  } finally {
    // onEnable schedules the background pass; without this it would fire mid-suite and self-call the host.
    await plugin.onDisable();
  }
}

const connected = { seerrUrl: 'http://seerr.test:5055', seerrApiKey: 'k' };

test('a reachable Seerr with no recipients is healthy, and says what is missing', async () => {
  // An empty recipient list is an unfinished setup, not a fault — it is the normal state of a fresh
  // install, and it is already obvious on the Recipients tab. Failing for it makes a new install look
  // broken and teaches the operator to ignore the badge.
  const health = await healthOf(connected);
  assert.equal(health.healthy, true);
  assert.match(health.message ?? '', /Seerr v3\.4\.1/);
  assert.match(health.message ?? '', /No recipients yet/);
});

test('the verdict follows the Seerr connection', async () => {
  const unconfigured = await healthOf({});
  assert.equal(unconfigured.healthy, false, 'no connection means nothing can be verified');
  assert.match(unconfigured.message ?? '', /Add your Seerr address and API key/);

  const unreachable = await healthOf(connected, async () => {
    throw new Error('connect ECONNREFUSED');
  });
  assert.equal(unreachable.healthy, false);
  assert.match(unreachable.message ?? '', /Cannot reach/);

  const rejectedKey = await healthOf(connected, async (url) =>
    url.includes('/status')
      ? { ok: true, status: 200, statusText: '', headers: {}, body: JSON.stringify({ version: '3.4.1' }) }
      : { ok: false, status: 403, statusText: '', headers: {}, body: '' },
  );
  assert.equal(rejectedKey.healthy, false, 'a rejected key produces no visible symptom until a message arrives bare');
  assert.match(rejectedKey.message ?? '', /API key was rejected/);
});

test('a fully configured plugin leads with the version and adds no unrelated complaint', async () => {
  const health = await healthOf({
    ...connected,
    users: [{ seerrUserId: 1, number: '15550000001', enabled: true }],
    seerrRoster: [{ id: 1, name: 'Someone', email: 'a@b.c', isAdmin: true }],
  });
  assert.equal(health.healthy, true);
  assert.ok(health.message?.startsWith('Seerr v3.4.1'), health.message);
  assert.doesNotMatch(health.message ?? '', /recipients/i, 'a working install gets no advice it did not ask for');
});

test('a gateway this plugin cannot query costs a note, never the verdict', async () => {
  // Off-host there is no admin key to read, so the send-side check cannot run. It reports the blind spot
  // rather than inventing a verdict: the delivery path has its own fallbacks and may be perfectly fine,
  // and a health check that failed on its own inability to look would be worse than useless.
  const health = await healthOf({
    ...connected,
    users: [{ seerrUserId: 1, number: '15550000001', enabled: true }],
    seerrRoster: [{ id: 1, name: 'Someone', email: 'a@b.c', isAdmin: true }],
  });
  assert.equal(health.healthy, true);
  assert.match(health.message ?? '', /Could not check which session will send/);
});

test('a broken connection is reported on its own', async () => {
  // A tester saw: "Cannot reach … Blocked internal address … Check the address, and SSRF_ALLOWED_HOSTS
  // if it is a private one. No recipients yet — tick someone on the Recipients tab…". Two unrelated
  // problems in one toast, the actionable one buried. Someone whose Seerr is unreachable has one job.
  const health = await healthOf(connected, async () => {
    throw new Error('Blocked internal address: 192.168.8.25');
  });

  assert.equal(health.healthy, false);
  assert.match(health.message ?? '', /SSRF_ALLOWED_HOSTS=/);
  assert.doesNotMatch(health.message ?? '', /No recipients yet/, 'one problem at a time');
});
