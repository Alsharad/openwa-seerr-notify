import assert from 'node:assert/strict';
import test from 'node:test';

import { SEERR_TEST_PAYLOAD, sendTestMessage } from './test-send.ts';
import type { HandlerDeps } from './handler.ts';
import { readConfig } from './config.ts';
import type { ConversationSendEnvelope, PluginNetResponse } from './types/openwa';

const base = {
  seerrUrl: 'http://seerr.local:5055',
  seerrApiKey: 'k',
  users: [
    { seerrUserId: 1, number: '15550000001', enabled: true },
    { seerrUserId: 2, number: '15550000002', enabled: true },
  ],
  seerrRoster: [
    { id: 1, name: 'Boss', email: 'boss@example.com', isAdmin: true },
    { id: 2, name: 'Someone', email: 'a@b.c', isAdmin: false },
  ],
};

function harness(raw: Record<string, unknown> = base) {
  const sent: ConversationSendEnvelope[] = [];
  const store = new Map<string, unknown>();
  const deps: HandlerDeps = {
    config: readConfig(raw),
    net: async (): Promise<PluginNetResponse> => ({ ok: false, status: 502, statusText: '', headers: {}, body: '{}' }),
    send: async (env) => {
      sent.push(env);
      return {};
    },
    storage: {
      get: async <T>(k: string) => (store.get(k) ?? null) as T | null,
      set: async (k, v) => {
        store.set(k, v);
      },
    },
    log: () => {},
    sleep: async () => {},
    resolveSession: async () => ({ ok: true, sessionId: 's', stale: false }),
  };
  return { deps, sent };
}

test('the test payload is byte-identical to what Seerr sends', () => {
  // Captured from a live Seerr 3.4.1 test press. A tidier payload would not be evidence about the real
  // one — the null media/request/issue/comment keys are exactly the shape that must keep working.
  assert.deepEqual(SEERR_TEST_PAYLOAD, {
    notification_type: 'TEST_NOTIFICATION',
    event: '',
    subject: 'Test Notification',
    message: 'Check check, 1, 2, 3. Are we coming in clear?',
    image: '',
    media: null,
    request: null,
    issue: null,
    comment: null,
    extra: [],
  });
});

test('a test goes to admins only, and says who it reached', async () => {
  const { deps, sent } = harness();
  const result = await sendTestMessage({ handler: deps, sessionId: 's', deliveryId: 'd1' });

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1, 'TEST_NOTIFICATION routes to admins, not to every recipient');
  assert.equal(sent[0].sessionId, 's');
  assert.equal(sent[0].chatId, '15550000001@c.us');
  assert.match(result.message, /1 recipient/);
  assert.doesNotMatch(result.message, /15550000001@c\.us/, 'the number must be masked in operator-facing text');
});

test('no admin is reported as a configuration problem, not a button failure', async () => {
  const { deps, sent } = harness({
    ...base,
    users: [{ seerrUserId: 2, number: '15550000002', enabled: true }],
  });
  const result = await sendTestMessage({ handler: deps, sessionId: 's', deliveryId: 'd2' });

  assert.equal(result.ok, false);
  assert.equal(sent.length, 0);
  assert.match(result.message, /admin/i, 'the cause is that nobody ticked is a Seerr admin — say so');
});

test('it can be run repeatedly — nothing about it is deduplicated', async () => {
  // The entire reason this button exists: OpenWA dedupes ingress on a hash of the body, and a Seerr test
  // body never varies, so its own Test button works exactly once. This path is not a webhook.
  const { deps, sent } = harness();
  for (let i = 0; i < 3; i += 1) {
    const result = await sendTestMessage({ handler: deps, sessionId: 's', deliveryId: `d${i}` });
    assert.equal(result.ok, true);
  }
  assert.equal(sent.length, 3);
});
