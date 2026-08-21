import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseSession, clearSessionCache, describeSending, resolveSessionId } from './session-resolve.ts';
import type { SessionInfo } from './session-resolve.ts';

const ready = (id: string, name: string): SessionInfo => ({ id, name, status: 'ready' });

test('a bound, ready session is used unchanged — the fallback never overrides an explicit choice', () => {
  const choice = chooseSession('a', [ready('a', 'one'), ready('b', 'two')]);
  assert.deepEqual(choice, { ok: true, sessionId: 'a', stale: false });
});

test('one ready session covers an unbound instance', () => {
  assert.deepEqual(chooseSession(undefined, [ready('a', 'one')]), { ok: true, sessionId: 'a', stale: false });
});

test('two ready sessions is a real ambiguity — it fails and names them rather than picking', () => {
  const choice = chooseSession(undefined, [ready('a', 'one'), ready('b', 'two')]);
  assert.equal(choice.ok, false);
  assert.match(choice.ok === false ? choice.detail : '', /"one", "two"/);
  assert.match(choice.ok === false ? choice.detail : '', /Configure > Instances/);
});

test('no connected session says so, rather than blaming the binding', () => {
  const choice = chooseSession(undefined, [{ id: 'a', name: 'one', status: 'pairing' }]);
  assert.equal(choice.ok, false);
  assert.match(choice.ok === false ? choice.detail : '', /no WhatsApp session is connected/);
});

test('a bound session that exists but is not ready fails — it does not silently use a different one', () => {
  // The whole safety argument rests on this: an operator who named a session must never have a delivery
  // sent from another one behind their back, even when exactly one other is available.
  const choice = chooseSession('a', [{ id: 'a', name: 'one', status: 'stopped' }, ready('b', 'two')]);
  assert.equal(choice.ok, false);
  assert.match(choice.ok === false ? choice.detail : '', /"one", which is stopped/);
});

test('a binding to a session that no longer exists falls back, and is flagged stale', () => {
  // Deleting and re-pairing a session mints a NEW id, so a stored binding rots. There is no instruction
  // left to contradict, so the single-ready rule applies as it would to an unbound instance.
  assert.deepEqual(chooseSession('gone', [ready('b', 'two')]), { ok: true, sessionId: 'b', stale: true });
});

test('a rotted binding with two candidates still refuses to guess', () => {
  const choice = chooseSession('gone', [ready('a', 'one'), ready('b', 'two')]);
  assert.equal(choice.ok, false);
});

function gateway(routes: Record<string, { ok?: boolean; status?: number; body: string }>) {
  return {
    selfFetch: async (url: string) => {
      const hit = Object.entries(routes).find(([path]) => url.includes(path));
      if (!hit) throw new Error(`unexpected call: ${url}`);
      const r = hit[1];
      return { ok: r.ok ?? true, status: r.status ?? 200, text: async () => r.body };
    },
    readApiKey: async () => 'k',
    selfUrl: 'http://127.0.0.1:2785',
    pluginId: 'seerr-notify',
  };
}

test('an unreachable gateway does not break an install that was already bound', async () => {
  clearSessionCache();
  const deps = {
    selfFetch: async () => {
      throw new Error('ECONNREFUSED');
    },
    readApiKey: async () => 'k',
    selfUrl: 'http://127.0.0.1:2785',
    pluginId: 'seerr-notify',
  };
  assert.deepEqual(await resolveSessionId(deps, 'bound'), { ok: true, sessionId: 'bound', stale: false });
});

test('an unreachable gateway fails an unbound instance with the reason', async () => {
  clearSessionCache();
  const deps = {
    selfFetch: async () => {
      throw new Error('ECONNREFUSED');
    },
    readApiKey: async () => 'k',
    selfUrl: 'http://127.0.0.1:2785',
    pluginId: 'seerr-notify',
  };
  const choice = await resolveSessionId(deps, undefined);
  assert.equal(choice.ok, false);
  assert.match(choice.ok === false ? choice.detail : '', /ECONNREFUSED/);
});

test('the session list is memoized, so a burst of deliveries is one gateway call', async () => {
  clearSessionCache();
  let calls = 0;
  const deps = {
    selfFetch: async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify([ready('a', 'one')]) };
    },
    readApiKey: async () => 'k',
    selfUrl: 'http://127.0.0.1:2785',
    pluginId: 'seerr-notify',
    clock: () => 1_000,
  };
  await resolveSessionId(deps, undefined);
  await resolveSessionId(deps, undefined);
  assert.equal(calls, 1);
});

test('health names the session deliveries will go out from', async () => {
  clearSessionCache();
  const deps = gateway({
    '/instances': { body: JSON.stringify([{ instanceId: 'seerr', sessionScope: 'a', enabled: true }]) },
    '/api/sessions': { body: JSON.stringify([ready('a', 'seerr-bot')]) },
  });
  assert.deepEqual(await describeSending(deps), { ok: true, note: 'Sending from "seerr-bot".' });
});

test('health fails when an instance cannot send — the gap that let every delivery die while green', async () => {
  clearSessionCache();
  const deps = gateway({
    '/instances': { body: JSON.stringify([{ instanceId: 'seerr', sessionScope: null, enabled: true }]) },
    '/api/sessions': { body: JSON.stringify([ready('a', 'one'), ready('b', 'two')]) },
  });
  const result = await describeSending(deps);
  assert.equal(result.ok, false);
  assert.match(result.note, /"seerr" cannot send/);
});

test('health flags having no instance at all', async () => {
  clearSessionCache();
  const deps = gateway({ '/instances': { body: '[]' }, '/api/sessions': { body: '[]' } });
  const result = await describeSending(deps);
  assert.equal(result.ok, false);
  assert.match(result.note, /No ingress instance yet/);
});

test('health reports a blind spot as a note, not as a failure', async () => {
  // The delivery path has its own fallbacks, so a gateway hiccup here is not evidence of a broken install.
  clearSessionCache();
  const deps = gateway({ '/instances': { ok: false, status: 500, body: 'boom' } });
  const result = await describeSending(deps);
  assert.equal(result.ok, true);
  assert.match(result.note, /Could not check which session will send/);
});
