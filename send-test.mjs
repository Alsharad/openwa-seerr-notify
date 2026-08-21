#!/usr/bin/env node
// Fire a realistic Seerr webhook at your ingress route, for testing.
//
// WHY THIS EXISTS. Seerr's own "Test Notification" button is close to useless as a test rig, for two
// reasons. It only ever sends `TEST_NOTIFICATION`, so it exercises none of the formatting you actually
// care about — no Now Available message, no issue comment, no admin variant. And its payload is
// byte-identical every time, which collides with OpenWA's ingress de-duplication: the id is derived from
// `sha256(pluginId, instanceId, route, rawBody)` when the provider sends no delivery-id header, so the
// SECOND press and every one after it is answered `200 duplicate` and never reaches the plugin. That is
// not a bug in either project — it is what stops a crash-recovery replay from double-messaging real
// people — but it does mean the button works exactly once per week.
//
// This script sends whichever event you ask for, with a `_nonce` field so every run is a fresh delivery.
// The plugin ignores unknown payload keys (Seerr's own payload is passthrough), so the nonce changes the
// hash without changing a single character of the message.
//
// Usage:
//   SEERR_INGRESS_TOKEN=<secret> node send-test.mjs                              # TEST_NOTIFICATION
//   SEERR_INGRESS_TOKEN=<secret> node send-test.mjs MEDIA_AVAILABLE --as alice    # the rich one
//   SEERR_INGRESS_TOKEN=<secret> node send-test.mjs ISSUE_COMMENT --as alice
//   node send-test.mjs --list
//
// `--as` sets who the event is FROM — the requester on MEDIA_*, the reporter on ISSUE_*. It must be the
// Seerr username or email of a mapped, enabled recipient, or the plugin resolves no recipients and
// records `no_recipients`. Events that route only to admins (TEST_NOTIFICATION by default) ignore it.
//
// Environment:
//   SEERR_INGRESS_TOKEN  required — the instance secret, sent as the Authorization header exactly as
//                        Seerr's webhook agent sends it (a bare value, no scheme). Shown once when the
//                        instance was created
//                        (regenerate: POST /api/integration/plugins/seerr-notify/instances/<id>/regenerate-secret)
//   INGRESS_URL          default http://localhost:2785/api/ingress/seerr-notify/seerr-prod/seerr
//                        The last path segment before /seerr is your INSTANCE id, which you chose when
//                        you created it — `seerr-prod` is only the name the docs use. Copy the real URL
//                        from the plugin's Setup tab if yours differs.
//   TMDB_ID              default 693134 (Dune: Part Two) — the title enrichment will look up

const INGRESS_URL =
  process.env.INGRESS_URL ?? 'http://localhost:2785/api/ingress/seerr-notify/seerr-prod/seerr';
const TOKEN = (process.env.SEERR_INGRESS_TOKEN ?? '').trim();
const TMDB_ID = Number(process.env.TMDB_ID ?? 693134);

const asIndex = process.argv.indexOf('--as');
const AS = (asIndex !== -1 ? process.argv[asIndex + 1] : process.env.SEERR_AS) ?? '';
const AS_EMAIL = AS.includes('@') ? AS : '';
const AS_USERNAME = AS.includes('@') ? '' : AS;

// A made-up request_id is deliberate: enrichment will 404 on it and fall back to the identity below,
// which is exactly the path a deployment without a Seerr API key takes.
const REQUESTER = {
  request_id: 4242,
  requestedBy_email: AS_EMAIL,
  requestedBy_username: AS_USERNAME,
  requestedBy_avatar: '',
};
const REPORTER = { reportedBy_email: AS_EMAIL, reportedBy_username: AS_USERNAME };
const MOVIE = { media_type: 'movie', tmdbId: TMDB_ID, tvdbId: null, status: 'AVAILABLE', status4k: 'UNKNOWN' };
const POSTER = 'https://image.tmdb.org/t/p/w600_and_h900_bestv2/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg';

/** Shaped like Seerr's default JSON payload template, one preset per notification type. */
const PRESETS = {
  TEST_NOTIFICATION: {
    event: 'Test Notification',
    subject: 'Test Notification',
    message: 'Check check, 1, 2, 3. Are we coming in clear?',
  },
  MEDIA_PENDING: {
    event: 'New Movie Request',
    subject: 'Dune: Part Two (2024)',
    message: 'Paul Atreides unites with the Fremen to wage war against House Harkonnen.',
    image: POSTER,
    media: MOVIE,
    request: REQUESTER,
  },
  MEDIA_APPROVED: { event: 'Movie Request Approved', subject: 'Dune: Part Two (2024)', media: MOVIE, request: REQUESTER },
  MEDIA_DECLINED: { event: 'Movie Request Declined', subject: 'Dune: Part Two (2024)', media: MOVIE, request: REQUESTER },
  MEDIA_FAILED: {
    event: 'Movie Request Failed',
    subject: 'Dune: Part Two (2024)',
    message: 'Radarr returned 400: quality profile not found',
    media: MOVIE,
    request: REQUESTER,
  },
  MEDIA_AVAILABLE: {
    event: 'Movie Request Now Available',
    subject: 'Dune: Part Two (2024)',
    image: POSTER,
    media: MOVIE,
    request: REQUESTER,
  },
  MEDIA_AUTO_APPROVED: { event: 'Movie Request Automatically Approved', subject: 'Dune: Part Two (2024)', media: MOVIE, request: REQUESTER },
  MEDIA_AUTO_REQUESTED: { event: 'Movie Automatically Requested', subject: 'Dune: Part Two (2024)', media: MOVIE, request: REQUESTER },
  ISSUE_CREATED: {
    event: 'New Issue Reported',
    subject: 'Dune: Part Two (2024)',
    message: 'Audio is out of sync from about 20 minutes in.',
    media: MOVIE,
    issue: { issue_id: 77, issue_type: 'AUDIO', issue_status: 'OPEN', ...REPORTER },
  },
  ISSUE_COMMENT: {
    event: 'New Comment on Issue',
    subject: 'Dune: Part Two (2024)',
    media: MOVIE,
    issue: { issue_id: 77, issue_type: 'AUDIO', issue_status: 'OPEN', ...REPORTER },
    comment: { comment_message: 'Re-encoded it, please try again.', commentedBy_username: 'admin' },
  },
  ISSUE_RESOLVED: {
    event: 'Issue Resolved',
    subject: 'Dune: Part Two (2024)',
    media: MOVIE,
    issue: { issue_id: 77, issue_type: 'AUDIO', issue_status: 'RESOLVED', ...REPORTER, resolvedBy_username: 'admin' },
  },
  ISSUE_REOPENED: {
    event: 'Issue Reopened',
    subject: 'Dune: Part Two (2024)',
    media: MOVIE,
    issue: { issue_id: 77, issue_type: 'AUDIO', issue_status: 'OPEN', ...REPORTER },
  },
};

const args = process.argv.slice(2);
if (args.includes('--list') || args.includes('-l')) {
  console.log('Event types:\n  ' + Object.keys(PRESETS).join('\n  '));
  process.exit(0);
}

const type = (args[0] ?? 'TEST_NOTIFICATION').toUpperCase();
if (!PRESETS[type]) {
  console.error(`✗ unknown event "${type}". Try --list.`);
  process.exit(1);
}
if (!TOKEN) {
  console.error('✗ SEERR_INGRESS_TOKEN is required — it is the ingress instance secret.');
  process.exit(1);
}

// TEST_NOTIFICATION is admin-routed; everything else reaches its requester/reporter, so without --as
// there is nobody to match and the delivery ends as `no_recipients`.
if (type !== 'TEST_NOTIFICATION' && !AS) {
  console.error(`⚠ ${type} is delivered to its requester/reporter, and no --as was given.`);
  console.error('  Pass --as <seerr-username|email> of a mapped, enabled recipient, or this will resolve nobody.');
}

const payload = {
  notification_type: type,
  event: '',
  subject: '',
  message: '',
  image: '',
  media: null,
  request: null,
  issue: null,
  comment: null,
  extra: [],
  ...PRESETS[type],
  // The only reason this script can be run twice: it changes the body hash, and therefore the derived
  // delivery id, without touching anything the plugin renders.
  _nonce: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
};

const res = await fetch(INGRESS_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: TOKEN },
  body: JSON.stringify(payload),
});
const body = await res.text();

console.log(`${type} → HTTP ${res.status} ${body}`);
if (res.status === 401) console.error('  The token was rejected. Check SEERR_INGRESS_TOKEN against the instance secret.');
if (res.status === 404) console.error('  No such plugin/instance/route. Check INGRESS_URL.');
if (res.status === 503) console.error('  The bound WhatsApp session is not alive.');
if (body.includes('duplicate')) console.error('  Deduplicated — that should be impossible here; is _nonce being stripped?');
if (res.ok) console.log('  Accepted. Delivery runs in the background; check WhatsApp and the plugin logs.');
