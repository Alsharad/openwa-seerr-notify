import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from './config.ts';
import { normalizePayload } from './normalize.ts';
import { resolveRecipients } from './recipients.ts';

const config = readConfig({
  users: [
    { number: '+15550000001', seerrUserId: 1, email: 'user@example.com', username: 'user', isAdmin: false },
    { number: '+15550000002', seerrUserId: 9, email: 'admin@example.com', username: 'admin', isAdmin: true },
  ],
});

const event = (type: string, extra: Record<string, unknown> = {}) =>
  normalizePayload({ notification_type: type, subject: 'Some Title', ...extra });

const requestedByUser = { request: { request_id: 5, requestedBy_email: 'user@example.com', requestedBy_username: 'user' } };
const reportedByUser = { issue: { issue_id: 3, reportedBy_email: 'user@example.com', reportedBy_username: 'user' } };

const chatIds = (type: string, extra?: Record<string, unknown>) =>
  resolveRecipients(config, event(type, extra)).map((r) => r.chatId);

test('MEDIA_AVAILABLE reaches the requester only — admins do not need the noise', () => {
  assert.deepEqual(chatIds('MEDIA_AVAILABLE', requestedByUser), ['15550000001@c.us']);
});

test('MEDIA_PENDING reaches the requester and every admin', () => {
  assert.deepEqual(chatIds('MEDIA_PENDING', requestedByUser), ['15550000001@c.us', '15550000002@c.us']);
});

test('ISSUE_* reaches the reporter and every admin', () => {
  assert.deepEqual(chatIds('ISSUE_CREATED', reportedByUser), ['15550000001@c.us', '15550000002@c.us']);
});

test('TEST_NOTIFICATION reaches admins only', () => {
  assert.deepEqual(chatIds('TEST_NOTIFICATION'), ['15550000002@c.us']);
});

test('an unmatched requester still lets the admins through on an admin-relevant event', () => {
  assert.deepEqual(chatIds('MEDIA_APPROVED'), ['15550000002@c.us']);
});

test('an unmatched requester on a requester-only event reaches nobody', () => {
  assert.deepEqual(chatIds('MEDIA_AVAILABLE'), []);
});

test('an unknown event type reaches nobody rather than fanning out to admins', () => {
  assert.deepEqual(chatIds('SOMETHING_NEW'), []);
});

test('an admin who is also the requester is listed once, keeping the admin message', () => {
  const admins = resolveRecipients(
    config,
    event('MEDIA_PENDING', {
      request: { request_id: 5, requestedBy_email: 'admin@example.com', requestedBy_username: 'admin' },
    }),
  );
  assert.equal(admins.length, 1);
  assert.equal(admins[0].chatId, '15550000002@c.us');
  assert.equal(admins[0].isAdmin, true);
});

test('matching falls back to email and username when no Seerr id is available', () => {
  const byUsername = resolveRecipients(
    config,
    event('MEDIA_AVAILABLE', { request: { requestedBy_username: 'USER' } }),
  );
  assert.deepEqual(byUsername.map((r) => r.chatId), ['15550000001@c.us']);
});
