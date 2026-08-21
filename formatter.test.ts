import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaAvailableFlags } from './config.ts';
import { formatMessages } from './formatter.ts';
import { normalizePayload } from './normalize.ts';
import type { MediaDetails, NormalizedEvent } from './normalize.ts';

const allOn: MediaAvailableFlags = {
  showReleaseDate: true,
  showRatings: true,
  showOverview: true,
  showGenres: true,
  showDirector: true,
  showCast: true,
  showTrailer: true,
  showSeasons: true,
  showCollection: true,
};
const allOff: MediaAvailableFlags = Object.fromEntries(
  Object.keys(allOn).map((k) => [k, false]),
) as unknown as MediaAvailableFlags;

const movieDetails: MediaDetails = {
  title: 'The Polar Express',
  releaseDate: '2004-11-10T00:00:00.000Z',
  overview: 'A boy boards a train to the North Pole.',
  voteAverage: 7.1,
  runtime: 100,
  genres: [{ name: 'Animation' }, { name: 'Family' }],
  credits: { crew: [{ name: 'Robert Zemeckis', job: 'Director' }], cast: [{ name: 'Tom Hanks', character: 'Conductor' }] },
  relatedVideos: [{ type: 'Trailer', site: 'YouTube', url: 'https://youtu.be/abc' }],
  collection: { name: 'Christmas Collection' },
};

const available = (extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  ...normalizePayload({ notification_type: 'MEDIA_AVAILABLE', subject: 'The Polar Express', media: { media_type: 'movie' } }),
  ...extra,
});

test('MEDIA_AVAILABLE renders every enabled section', () => {
  const { userMessage } = formatMessages(available({ mediaDetails: movieDetails }), allOn);
  assert.match(userMessage, /^✅ Now Available/);
  assert.match(userMessage, /\*The Polar Express\*/);
  assert.match(userMessage, /📅 2004-11-10/);
  assert.match(userMessage, /⭐ 7\.1\/10/);
  assert.match(userMessage, /⏱ 100 min/);
  assert.match(userMessage, /_A boy boards a train to the North Pole\._/);
  assert.match(userMessage, /🎭 Animation, Family/);
  assert.match(userMessage, /🎬 Robert Zemeckis/);
  assert.match(userMessage, /\* Tom Hanks as Conductor/);
  assert.match(userMessage, /🎥 https:\/\/youtu\.be\/abc/);
  assert.match(userMessage, /Part of: \*Christmas Collection\*/);
});

test('every section can be switched off, leaving only the headline', () => {
  const { userMessage } = formatMessages(available({ mediaDetails: movieDetails }), allOff);
  assert.equal(userMessage, '✅ Now Available\n*The Polar Express*');
});

test('a rating from the ratings API outranks the TMDB vote average', () => {
  const withRt = available({ mediaDetails: movieDetails, mediaRatings: { rt: { criticsScore: 92 } } });
  assert.match(formatMessages(withRt, allOn).userMessage, /⭐ 92%/);
  const withImdb = available({ mediaDetails: movieDetails, mediaRatings: { imdb: { criticsScore: 8.4 } } });
  assert.match(formatMessages(withImdb, allOn).userMessage, /⭐ 8\.4\/10/);
});

test('MEDIA_AVAILABLE without enrichment falls back to the bare headline', () => {
  const { userMessage } = formatMessages(available(), allOn);
  assert.equal(userMessage, '✅ Now Available\n\n🎬 The Polar Express');
});

test('TV seasons render with their tracked status, and specials are omitted', () => {
  const tv = normalizePayload({ notification_type: 'MEDIA_AVAILABLE', subject: 'Show', media: { media_type: 'tv' } });
  tv.mediaDetails = {
    name: 'Show',
    seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }, { seasonNumber: 2 }],
    mediaInfo: { seasons: [{ seasonNumber: 1, status: 5 }] },
  };
  const { userMessage } = formatMessages(tv, allOn);
  assert.match(userMessage, /\* Season 1 — ✅ Available/);
  assert.match(userMessage, /\* Season 2 — 📥 Can Request/);
  assert.doesNotMatch(userMessage, /Season 0/);
});

test('an admin-relevant event appends the Admin Info block; a requester-only event does not', () => {
  const pending = normalizePayload({
    notification_type: 'MEDIA_PENDING',
    subject: 'Dune',
    media: { media_type: 'movie' },
    request: { request_id: 42, requestedBy_username: 'alice' },
  });
  const { userMessage, adminMessage } = formatMessages(pending, allOn);
  assert.doesNotMatch(userMessage, /Admin Info/);
  assert.match(adminMessage, /━━━ Admin Info ━━━/);
  assert.match(adminMessage, /👤 Requested by: alice/);
  assert.match(adminMessage, /🆔 Request ID: 42/);
  assert.ok(adminMessage.startsWith(userMessage), 'the admin message extends the user message');

  // The Admin Info block is now a per-event operator toggle rather than a fixed list of event types.
  const availableEvent = available({ mediaDetails: movieDetails });
  assert.equal(
    formatMessages(availableEvent, allOn, false).adminMessage,
    formatMessages(availableEvent, allOn, false).userMessage,
    'toggled off, both copies are identical',
  );
  assert.match(
    formatMessages(availableEvent, allOn, true).adminMessage,
    /━━━ Admin Info ━━━/,
    'toggled on, MEDIA_AVAILABLE now carries the block too',
  );
});

test('an event with nothing to say to an admin ignores the toggle', () => {
  const test = normalizePayload({ notification_type: 'TEST_NOTIFICATION', subject: 'Test' });
  const { userMessage, adminMessage } = formatMessages(test, allOn, true);
  assert.equal(adminMessage, userMessage, 'TEST_NOTIFICATION has no requester, ids or issue to report');
});

test('MEDIA_FAILED names the *arr service that failed', () => {
  const movie = normalizePayload({ notification_type: 'MEDIA_FAILED', subject: 'Dune', media: { media_type: 'movie' } });
  assert.match(formatMessages(movie, allOn).adminMessage, /Failed to add to Radarr/);
  const tv = normalizePayload({ notification_type: 'MEDIA_FAILED', subject: 'Show', media: { media_type: 'tv' } });
  assert.match(formatMessages(tv, allOn).adminMessage, /Failed to add to Sonarr/);
});

test('an issue comment carries the comment text and the issue type emoji', () => {
  const event = normalizePayload({
    notification_type: 'ISSUE_COMMENT',
    subject: 'Show',
    issue: { issue_id: 7, issue_type: 'AUDIO', reportedBy_username: 'bob' },
    comment: { comment_message: 'Still out of sync', commentedBy_username: 'carol' },
  });
  const { userMessage, adminMessage } = formatMessages(event, allOn);
  assert.match(userMessage, /🔊 Issue Type: Audio/);
  assert.match(userMessage, /💬 Comment: Still out of sync/);
  assert.match(adminMessage, /👤 Commented by: carol/);
  assert.match(adminMessage, /🆔 Issue ID: 7/);
});

test('an unknown event type falls back to the payload message', () => {
  const event = normalizePayload({ notification_type: 'SOMETHING_NEW', subject: 'X', message: 'raw text' });
  assert.equal(formatMessages(event, allOn).userMessage, 'raw text');
});
