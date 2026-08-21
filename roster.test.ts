import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEERR_ADMIN_PERMISSION, identityFor, isSeerrAdmin, readRoster, rosterIndex, toRosterEntry } from './roster.ts';
import { readConfig } from './config.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

// Real permission values observed on a live Seerr 3.4.1 instance.
test('admin status comes from the Seerr permission bit', () => {
  assert.equal(isSeerrAdmin(2), true, 'ADMIN');
  assert.equal(isSeerrAdmin(4194464), false, 'a normal user with many permissions is not an admin');
  assert.equal(isSeerrAdmin(4194336), false);
  assert.equal(isSeerrAdmin(3), true, 'ADMIN alongside another bit');
  assert.equal(isSeerrAdmin(undefined), false);
  assert.equal(isSeerrAdmin('2'), false, 'a non-number is not silently coerced');
});

test('toRosterEntry keeps only the fields worth caching, and falls back to username', () => {
  assert.deepEqual(toRosterEntry({ id: 1, displayName: 'Alice', email: 'A@Ex.com', permissions: 2 }), {
    id: 1,
    name: 'Alice',
    email: 'a@ex.com',
    isAdmin: true,
  });
  assert.deepEqual(toRosterEntry({ id: 7, username: 'alice', permissions: 4194464 }), {
    id: 7,
    name: 'alice',
    email: '',
    isAdmin: false,
  });
  assert.equal(toRosterEntry({ displayName: 'no id' }), null);
});

test('readRoster ignores malformed entries rather than throwing', () => {
  const roster = readRoster([{ id: 1, name: 'a' }, { name: 'no id' }, null, 'nope', { id: 'x' }]);
  assert.deepEqual(roster.map((r) => r.id), [1]);
  assert.deepEqual(readRoster(undefined), []);
});

test('identity and admin status come from the roster, overriding whatever the row carries', () => {
  const roster = rosterIndex([{ id: 1, name: 'Alice', email: 'a@ex.com', isAdmin: true }]);
  const identity = identityFor(
    { seerrUserId: 1, number: '+1', enabled: true },
    { email: 'stale@ex.com', username: 'stale', isAdmin: false },
    roster,
  );
  assert.deepEqual(identity, { email: 'a@ex.com', username: 'alice', isAdmin: true });
});

test('a row the roster has never seen keeps its own identity, so a stale roster is not destructive', () => {
  const identity = identityFor(
    { seerrUserId: 99, number: '+1', enabled: true },
    { email: 'Legacy@Ex.com', username: 'Legacy', isAdmin: true },
    rosterIndex([]),
  );
  assert.deepEqual(identity, { email: 'legacy@ex.com', username: 'legacy', isAdmin: true });
});

test('readConfig resolves recipients from the roster', () => {
  const cfg = readConfig({
    seerrRoster: [
      { id: 1, name: 'Alice', email: 'admin@ex.com', isAdmin: true },
      { id: 11, name: 'Bob', email: 'bob@ex.com', isAdmin: false },
    ],
    users: [
      { seerrUserId: 1, number: '+15550000001', enabled: true },
      { seerrUserId: 11, number: '+15550000002', enabled: true },
    ],
  });

  assert.deepEqual(
    cfg.users.map((u) => ({ id: u.seerrUserId, admin: u.isAdmin, name: u.username })),
    [
      { id: 1, admin: true, name: 'alice' },
      { id: 11, admin: false, name: 'bob' },
    ],
  );
  assert.equal(cfg.roster.length, 2);
});

test('a disabled row, or one with no number, is not a recipient', () => {
  const base = {
    seerrRoster: [{ id: 1, name: 'A', email: '', isAdmin: true }, { id: 2, name: 'B', email: '', isAdmin: false }],
  };
  const cfg = readConfig({
    ...base,
    users: [
      { seerrUserId: 1, number: '+15551110000', enabled: true },
      { seerrUserId: 2, number: '+15552220000', enabled: false },
    ],
  });
  assert.deepEqual(cfg.users.map((u) => u.seerrUserId), [1]);

  assert.throws(
    () => readConfig({ ...base, users: [{ seerrUserId: 1, number: '', enabled: true }] }),
    /No recipients yet/,
  );
});

test('a pre-roster config still resolves, so an upgrade does not drop recipients', () => {
  // The 1.2.x shape: identity and admin flag on the row, no roster, no `enabled`.
  const cfg = readConfig({
    users: [{ number: '+15550000001', seerrUserId: 1, email: 'a@ex.com', username: 'Alice', isAdmin: true }],
  });
  assert.equal(cfg.users.length, 1);
  assert.equal(cfg.users[0].isAdmin, true);
  assert.equal(cfg.users[0].username, 'alice');
});

test('the refresh command uses the same admin bit as the plugin', () => {
  // The script is plain .mjs and cannot import the TypeScript constant, so the duplicate is pinned here.
  const script = readFileSync(join(HERE, 'refresh-roster.mjs'), 'utf8');
  const declared = /const SEERR_ADMIN_PERMISSION = (\d+);/.exec(script);
  assert.ok(declared, 'refresh-roster.mjs must declare SEERR_ADMIN_PERMISSION');
  assert.equal(Number(declared[1]), SEERR_ADMIN_PERMISSION);
});
