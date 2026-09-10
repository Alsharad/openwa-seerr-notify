import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePayload, sanitizeText, validatePayload } from './normalize.ts';

test('sanitizeText strips control characters and collapses whitespace, keeping unicode', () => {
  const raw = `a${String.fromCharCode(9)}b${String.fromCharCode(0)}  c  `;
  assert.equal(sanitizeText(raw), 'a b c');
  assert.equal(sanitizeText('Café 日本語 ✅'), 'Café 日本語 ✅');
  assert.equal(sanitizeText(undefined), '');
  assert.equal(sanitizeText('abcdef', 3), 'abc');
});

test('validatePayload requires a usable notification_type and nothing else', () => {
  assert.equal(validatePayload({ notification_type: 'MEDIA_AVAILABLE' }).ok, true);
  assert.equal(validatePayload({}).ok, false);
  assert.equal(validatePayload({ notification_type: '  ' }).ok, false);
  assert.equal(validatePayload('nope').ok, false);
  assert.equal(validatePayload(null).ok, false);
});

test('normalizePayload upper-cases the type, lower-cases actors, and defaults the subject', () => {
  const event = normalizePayload({
    notification_type: 'media_available',
    media: { media_type: 'MOVIE', tmdbId: 42 },
    request: { request_id: 7, requestedBy_email: 'User@Example.COM', requestedBy_username: 'Alice' },
  });

  assert.equal(event.notificationType, 'MEDIA_AVAILABLE');
  assert.equal(event.mediaType, 'movie');
  assert.equal(event.subject, 'Unknown Title');
  assert.equal(event.requester.email, 'user@example.com');
  assert.equal(event.requester.username, 'alice');
  assert.equal(event.eventIds.requestId, '7');
  assert.equal(event.eventIds.mediaTmdbId, '42');
  assert.equal(event.eventIds.issueId, null);
});

test('a missing media/request/issue block normalizes to empty rather than throwing', () => {
  const event = normalizePayload({ notification_type: 'TEST_NOTIFICATION' });
  assert.equal(event.mediaType, 'unknown');
  assert.deepEqual(event.requester, { email: '', username: '', userId: null });
  assert.equal(event.issueType, null);
  assert.equal(event.requestedSeasons, null);
});

test('requested seasons are read out of the extra array', () => {
  const event = normalizePayload({
    notification_type: 'MEDIA_PENDING',
    extra: [{ name: 'Requested Seasons', value: '1, 2' }],
  });
  assert.equal(event.requestedSeasons, '1, 2');
});
