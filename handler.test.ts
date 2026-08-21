import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSendEnvelope, PluginNetResponse, WebhookRequest } from './types/openwa';
import { readConfig } from './config.ts';
import type { SeerrConfig } from './config.ts';
import { normalizePayload } from './normalize.ts';
import { handleSeerrWebhook, processEvent } from './handler.ts';
import type { HandlerDeps } from './handler.ts';
import { DEAD_LETTER_KEY } from './deadletter.ts';
import type { DeadLetter } from './deadletter.ts';

const baseConfig = (extra: Record<string, unknown> = {}): SeerrConfig =>
  readConfig({
    users: [
      { number: '+15550000001', seerrUserId: 1, email: 'user@example.com', username: 'user', isAdmin: false },
      { number: '+15550000002', seerrUserId: 9, username: 'admin', isAdmin: true },
    ],
    ...extra,
  });

function harness(config: SeerrConfig = baseConfig(), netBody?: Record<string, unknown>) {
  const store = new Map<string, unknown>();
  const sent: ConversationSendEnvelope[] = [];
  const logs: string[] = [];
  const fetched: string[] = [];

  const deps: HandlerDeps = {
    config,
    net: async (url): Promise<PluginNetResponse> => {
      fetched.push(url);
      return {
        ok: netBody !== undefined,
        status: netBody !== undefined ? 200 : 502,
        statusText: '',
        headers: {},
        body: JSON.stringify(netBody ?? {}),
      };
    },
    send: async (env) => {
      sent.push(env);
      return {};
    },
    storage: {
      get: async <T>(key: string) => (store.get(key) ?? null) as T | null,
      set: async (key, value) => {
        store.set(key, value);
      },
    },
    log: (m) => logs.push(m),
    sleep: async () => {},
    now: () => '2026-01-01T00:00:00.000Z',
  };

  const deadLetters = () => (store.get(DEAD_LETTER_KEY) ?? []) as DeadLetter[];
  return { deps, sent, logs, fetched, deadLetters };
}

const request = (body: unknown): WebhookRequest => ({
  instanceId: 'seerr-prod',
  method: 'POST',
  headers: {},
  query: {},
  body: typeof body === 'string' ? body : JSON.stringify(body),
  rawBody: typeof body === 'string' ? body : JSON.stringify(body),
  verified: true,
  deliveryId: 'delivery-1',
  sessionId: 'sess',
});

/** An instance the operator never bound to a session. Built by override: passing `undefined` to a
 *  defaulted parameter would silently take the default instead. */
const requestWithoutSession = (body: unknown): WebhookRequest => ({ ...request(body), sessionId: undefined });

const availablePayload = {
  notification_type: 'MEDIA_AVAILABLE',
  subject: 'Dune',
  image: 'https://image.tmdb.org/t/p/w600/dune.jpg',
  media: { media_type: 'movie', tmdbId: 438631 },
  request: { request_id: 7, requestedBy_email: 'user@example.com', requestedBy_username: 'user' },
};

test('a Now Available event delivers one captioned poster to the requester', async () => {
  const { deps, sent } = harness();
  const event = normalizePayload(availablePayload);
  await processEvent(deps, event, request(availablePayload), 'sess');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'image');
  assert.equal(sent[0].chatId, '15550000001@c.us');
  assert.equal(sent[0].mediaUrl, 'https://image.tmdb.org/t/p/w600/dune.jpg');
  assert.match(String(sent[0].text), /✅ Now Available/);
});

test('admins get the admin message and regular users do not, in the same delivery', async () => {
  const { deps, sent } = harness();
  const payload = { ...availablePayload, notification_type: 'MEDIA_PENDING' };
  await processEvent(deps, normalizePayload(payload), request(payload), 'sess');

  assert.equal(sent.length, 2);
  const [toUser, toAdmin] = sent;
  assert.equal(toUser.chatId, '15550000001@c.us');
  assert.doesNotMatch(String(toUser.text), /Admin Info/);
  assert.equal(toAdmin.chatId, '15550000002@c.us');
  assert.match(String(toAdmin.text), /Admin Info/);
});

test('enrichment is skipped entirely when it is not configured', async () => {
  const { deps, fetched } = harness();
  await processEvent(deps, normalizePayload(availablePayload), request(availablePayload), 'sess');
  assert.deepEqual(fetched, []);
});

test('a Seerr API failure degrades the message instead of dropping the delivery', async () => {
  // netBody undefined ⇒ every enrichment call answers 502.
  const config = baseConfig({ jellyseerrUrl: 'http://seerr:5055', jellyseerrApiKey: 'k' });
  const { deps, sent, fetched } = harness(config);
  await processEvent(deps, normalizePayload(availablePayload), request(availablePayload), 'sess');

  assert.ok(fetched.length > 0, 'enrichment was attempted');
  assert.equal(sent.length, 1, 'the notification still went out');
  assert.match(String(sent[0].text), /✅ Now Available/);
});

test('a malformed body is dead-lettered and sends nothing', async () => {
  const { deps, sent, deadLetters } = harness();
  await handleSeerrWebhook(deps, request('{not json'));

  assert.equal(sent.length, 0);
  assert.equal(deadLetters().length, 1);
  assert.equal(deadLetters()[0].reason, 'invalid_payload');
});

test('a payload without notification_type is dead-lettered', async () => {
  const { deps, deadLetters } = harness();
  await handleSeerrWebhook(deps, request({ subject: 'no type' }));

  assert.equal(deadLetters().length, 1);
  assert.match(String(deadLetters()[0].detail), /notification_type/);
});

test('an event matching no configured user is dead-lettered when a mapping is required', async () => {
  const { deps, sent, deadLetters } = harness();
  const payload = { notification_type: 'MEDIA_AVAILABLE', subject: 'X', request: { requestedBy_username: 'nobody' } };
  await processEvent(deps, normalizePayload(payload), request(payload), 'sess');

  assert.equal(sent.length, 0);
  assert.equal(deadLetters()[0].reason, 'no_recipients');
});

test('an unmatched event is dropped quietly when a mapping is not required', async () => {
  const { deps, deadLetters } = harness(baseConfig({ requireMappedUser: false }));
  const payload = { notification_type: 'MEDIA_AVAILABLE', subject: 'X', request: { requestedBy_username: 'nobody' } };
  await processEvent(deps, normalizePayload(payload), request(payload), 'sess');

  assert.equal(deadLetters().length, 0);
});

test('a delivery with no session to send from is dead-lettered', async () => {
  const { deps, sent, deadLetters } = harness();
  await handleSeerrWebhook(deps, requestWithoutSession(availablePayload));

  assert.equal(sent.length, 0);
  assert.equal(deadLetters()[0].reason, 'no_session');
});

test('an unbound instance fails with the fix in the dead letter, and never guesses a session', async () => {
  // There is no plugin-side fallback: which session to send from is the host's to decide, and a config
  // key that quietly answered it differently from the instance binding was one answer too many.
  const { deps, sent, deadLetters } = harness(baseConfig({ fallbackSessionId: 'ignored-if-present' }));
  await handleSeerrWebhook(deps, requestWithoutSession(availablePayload));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sent.length, 0, 'a stale fallbackSessionId in an older config must not resurrect the behaviour');
  assert.equal(deadLetters()[0].reason, 'no_session');
  assert.match(deadLetters()[0].detail ?? '', /Configure > Instances/, 'the dead letter must name the fix');
});

test('the handler returns without waiting for the sends — the 5 s dispatch budget is never at risk', async () => {
  const { deps, sent } = harness();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  deps.send = async (env) => {
    sent.push(env);
    await blocked; // a send that never settles, standing in for a slow poster upload
    return {};
  };

  let settled = false;
  const inFlight = (async () => {
    await blocked;
    settled = true;
  })();

  await handleSeerrWebhook(deps, request(availablePayload));
  // Let the floated work reach its first send.
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(sent.length, 1, 'the delivery started');
  assert.equal(settled, false, 'the handler returned while the send was still in flight');

  release();
  await inFlight;
});

test('a failed send is dead-lettered and stops that recipient without affecting the others', async () => {
  const { deps, sent, deadLetters } = harness();
  const payload = { ...availablePayload, notification_type: 'MEDIA_PENDING' };
  deps.send = async (env) => {
    sent.push(env);
    if (env.chatId === '15550000001@c.us') throw new Error('engine not ready');
    return {};
  };

  await processEvent(deps, normalizePayload(payload), request(payload), 'sess');

  const delivered = sent.filter((e) => e.chatId === '15550000002@c.us');
  assert.equal(delivered.length, 1, 'the admin still received the notification');
  assert.equal(deadLetters().length, 1);
  assert.equal(deadLetters()[0].reason, 'send_failed');
});
