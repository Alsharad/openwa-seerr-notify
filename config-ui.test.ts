// The editor is static HTML that no compiler checks, yet it carries two claims about behaviour: the
// routing defaults it seeds a fresh install with, and the set of config keys it round-trips. Both are
// asserted here against the code, so neither can drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_SECTIONS, readConfig } from './config.ts';
import { normalizePayload } from './normalize.ts';
import { resolveRecipients } from './recipients.ts';
import { formatMessages } from './formatter.ts';
import { DEFAULT_ROUTING, ROUTED_EVENTS, routingFor, supportsAdminInfo } from './routing.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, 'config', 'index.html'), 'utf8');

const USER_CHAT = '15550000001@c.us';
const ADMIN_CHAT = '15550000002@c.us';

const config = readConfig({
  users: [
    { number: '+15550000001', seerrUserId: 1, email: 'user@example.com', username: 'user', isAdmin: false },
    { number: '+15550000002', seerrUserId: 9, username: 'admin', isAdmin: true },
  ],
});

/** Parse the editor's DEFAULT_ROUTING literal — the defaults a fresh install is seeded with. */
function parseEditorDefaults(): Record<string, { user: boolean; admin: boolean; adminInfo: boolean }> {
  const block = /var DEFAULT_ROUTING = \{([\s\S]*?)\n  \};/.exec(html);
  assert.ok(block, 'could not find DEFAULT_ROUTING in the editor');

  const parsed: Record<string, { user: boolean; admin: boolean; adminInfo: boolean }> = {};
  const row = /([A-Z_]+):\s*\{\s*user:\s*(true|false),\s*admin:\s*(true|false),\s*adminInfo:\s*(true|false)\s*\}/g;
  for (const match of block[1].matchAll(row)) {
    parsed[match[1]] = { user: match[2] === 'true', admin: match[3] === 'true', adminInfo: match[4] === 'true' };
  }
  return parsed;
}

/** The actor behind the event is the NON-admin mapped user, so the two columns stay distinguishable. */
function eventFor(type: string) {
  const base: Record<string, unknown> = { notification_type: type, subject: 'Title', media: { media_type: 'movie' } };
  if (type.startsWith('ISSUE_')) {
    base.issue = { issue_id: 3, reportedBy_email: 'user@example.com', reportedBy_username: 'user' };
  } else {
    base.request = { request_id: 5, requestedBy_email: 'user@example.com', requestedBy_username: 'user' };
  }
  return normalizePayload(base);
}

test('the editor seeds exactly the defaults the plugin applies', () => {
  const editor = parseEditorDefaults();
  assert.deepEqual(Object.keys(editor).sort(), [...ROUTED_EVENTS].sort(), 'event list differs');
  for (const event of ROUTED_EVENTS) {
    assert.deepEqual(editor[event], DEFAULT_ROUTING[event], `${event} default differs from routing.ts`);
  }
});

test('the default routing produces the behaviour it always had', () => {
  const drift: string[] = [];

  for (const event of ROUTED_EVENTS) {
    const normalized = eventFor(event);
    const expected = DEFAULT_ROUTING[event];
    const chatIds = resolveRecipients(config, normalized).map((r) => r.chatId);

    const actualUser = chatIds.includes(USER_CHAT);
    const actualAdmin = chatIds.includes(ADMIN_CHAT);
    const { userMessage, adminMessage } = formatMessages(normalized, ALL_SECTIONS, expected.adminInfo);
    const actualAdminInfo = adminMessage !== userMessage;

    if (actualUser !== expected.user) drift.push(`${event}: user default ${expected.user}, code ${actualUser}`);
    if (actualAdmin !== expected.admin) drift.push(`${event}: admin default ${expected.admin}, code ${actualAdmin}`);
    if (actualAdminInfo !== expected.adminInfo) {
      drift.push(`${event}: adminInfo default ${expected.adminInfo}, code ${actualAdminInfo}`);
    }
  }

  assert.deepEqual(drift, []);
});

test('every event the operator can toggle Admin Info on actually produces one', () => {
  // A toggle that changes nothing is worse than no toggle: the editor renders the cell as N/A exactly
  // where supportsAdminInfo says there is no block to render, so those two must agree.
  for (const event of ROUTED_EVENTS) {
    if (!supportsAdminInfo(event)) continue;
    const normalized = eventFor(event);
    const { userMessage, adminMessage } = formatMessages(normalized, ALL_SECTIONS, true);
    assert.notEqual(adminMessage, userMessage, `${event} offers an Admin Info toggle but renders no block`);
    assert.match(adminMessage, /━━━ Admin Info ━━━/, `${event} admin copy is missing the block heading`);
  }
});

test('routing is honoured: flipping a cell changes who is resolved', () => {
  const custom = readConfig({
    users: [
      { number: '+15550000001', seerrUserId: 1, email: 'user@example.com', username: 'user', isAdmin: false },
      { number: '+15550000002', seerrUserId: 9, username: 'admin', isAdmin: true },
    ],
    // Copy admins on Now Available, and stop notifying the requester.
    routing: { MEDIA_AVAILABLE: { user: false, admin: true } },
  });

  const chatIds = resolveRecipients(custom, eventFor('MEDIA_AVAILABLE')).map((r) => r.chatId);
  assert.deepEqual(chatIds, [ADMIN_CHAT]);
  // Untouched rows keep their defaults.
  assert.deepEqual(routingFor(custom.routing, 'ISSUE_CREATED'), DEFAULT_ROUTING.ISSUE_CREATED);
});

test('the editor declares every field the manifest schema does, and no others', () => {
  const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8')) as {
    configSchema: { properties: Record<string, unknown> };
  };
  const declared = Object.keys(manifest.configSchema.properties).sort();

  // The host hands the iframe only schema-declared keys, so a field the editor writes but the schema
  // omits is silently dropped on the next read — and one the schema declares but the editor never
  // renders is unreachable while configUi is present.
  const scalars = /var SCALARS = \[([^\]]*)\]/.exec(html);
  const booleans = /var BOOLEANS = \[([^\]]*)\]/.exec(html);
  assert.ok(scalars && booleans, 'could not find the editor field lists');

  const names = (block: string) => [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const edited = [
    ...names(scalars[1]),
    ...names(booleans[1]),
    'users',
    // Round-tripped verbatim on an ordinary save; dropping them would erase the cache the editor needs.
    'seerrRoster',
    'rosterSyncedAt',
    // Re-stamped only by the Refresh button — the signal the plugin acts on.
    'rosterRefreshRequestedAt',
    'routing',
  ].sort();

  assert.deepEqual(edited, declared);
});

test('configUi points at the file that exists and is packaged by its top-level directory', () => {
  const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8')) as { configUi?: { entry?: string } };
  assert.equal(manifest.configUi?.entry, 'config/index.html');
  // Self-contained: an opaque-origin srcdoc iframe cannot load subresources.
  assert.doesNotMatch(html, /<script[^>]+\ssrc=/, 'external script would not load in the sandbox');
  assert.doesNotMatch(html, /<link[^>]+rel=["']stylesheet/, 'external stylesheet would not load in the sandbox');
});
