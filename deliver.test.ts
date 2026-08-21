import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationSendEnvelope } from './types/openwa';
import { MAX_CAPTION, MAX_TEXT, isHostTimeout, partToEnvelope, planSends, sendWithRetry, splitText } from './deliver.ts';

const POSTER = 'https://image.tmdb.org/t/p/w600/poster.jpg';
const noSleep = async (): Promise<void> => {};

test('a message that fits the caption limit ships as one captioned image', () => {
  const parts = planSends('Now Available', POSTER, true);
  assert.deepEqual(parts, [{ kind: 'image', mediaUrl: POSTER, caption: 'Now Available' }]);
});

test('an over-long message sends the poster uncaptioned, then the text', () => {
  const long = 'x'.repeat(MAX_CAPTION + 1);
  const parts = planSends(long, POSTER, true);
  assert.deepEqual(parts, [
    { kind: 'image', mediaUrl: POSTER },
    { kind: 'text', text: long },
  ]);
});

test('the poster is skipped when the operator turned it off, or there is none', () => {
  assert.deepEqual(planSends('hello', POSTER, false), [{ kind: 'text', text: 'hello' }]);
  assert.deepEqual(planSends('hello', null, true), [{ kind: 'text', text: 'hello' }]);
});

test('text beyond the 4096 limit is split, and every chunk stays within it', () => {
  const body = Array.from({ length: 600 }, (_, i) => `line ${i} ${'y'.repeat(20)}`).join('\n');
  assert.ok(body.length > MAX_TEXT);
  const parts = planSends(body, null, false);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.equal(part.kind, 'text');
    assert.ok(part.kind === 'text' && part.text.length <= MAX_TEXT);
  }
  // Nothing is lost or duplicated by the split.
  assert.equal(parts.map((p) => (p.kind === 'text' ? p.text : '')).join('\n'), body);
});

test('splitText breaks on line boundaries, and hard-splits a single over-long line', () => {
  assert.deepEqual(splitText('aa\nbb\ncc', 5), ['aa\nbb', 'cc']);
  assert.deepEqual(splitText('abcdefg', 3), ['abc', 'def', 'g']);
  assert.deepEqual(splitText('short', 100), ['short']);
});

test('partToEnvelope maps an image part to a captioned media send', () => {
  const env = partToEnvelope({ kind: 'image', mediaUrl: POSTER, caption: 'cap' }, 'sess', '1@c.us');
  assert.deepEqual(env, { sessionId: 'sess', chatId: '1@c.us', type: 'image', mediaUrl: POSTER, text: 'cap' });
});

test('isHostTimeout recognises the host capability timeout and nothing else', () => {
  assert.equal(isHostTimeout(new Error("capability 'conversation.send' timed out after 120000ms")), true);
  assert.equal(isHostTimeout(new Error('session not active')), false);
});

test('a transient failure is retried and then succeeds', async () => {
  let attempts = 0;
  const ok = await sendWithRetry(
    {
      send: async () => {
        attempts++;
        if (attempts < 3) throw new Error('engine not ready');
        return {};
      },
      sleep: noSleep,
      log: () => {},
    },
    { sessionId: 's', chatId: 'c', type: 'text', text: 'hi' },
  );
  assert.equal(ok, true);
  assert.equal(attempts, 3);
});

test('a persistent failure gives up after three attempts', async () => {
  let attempts = 0;
  const ok = await sendWithRetry(
    {
      send: async () => {
        attempts++;
        throw new Error('engine not ready');
      },
      sleep: noSleep,
      log: () => {},
    },
    { sessionId: 's', chatId: 'c', type: 'text', text: 'hi' },
  );
  assert.equal(ok, false);
  assert.equal(attempts, 3);
});

test('a host timeout is never retried, because the message may still have landed', async () => {
  let attempts = 0;
  const logs: string[] = [];
  const sent: ConversationSendEnvelope[] = [];
  const ok = await sendWithRetry(
    {
      send: async (env) => {
        attempts++;
        sent.push(env);
        throw new Error("capability 'conversation.send' timed out after 120000ms");
      },
      sleep: noSleep,
      log: (m) => logs.push(m),
    },
    { sessionId: 's', chatId: 'c', type: 'image', mediaUrl: POSTER },
  );
  assert.equal(ok, false);
  assert.equal(attempts, 1, 'a timed-out send must not be retried');
  assert.equal(sent.length, 1);
  assert.match(logs.join(' '), /may still arrive/);
});
