import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_SECTIONS, maskChatId, phoneToChatId, readConfig } from './config.ts';

const withUser = (extra: Record<string, unknown> = {}) => ({
  users: [{ number: '+62 812-3456-7890', seerrUserId: 1, isAdmin: true }],
  ...extra,
});

test('phoneToChatId strips formatting and rejects a number with no digits', () => {
  assert.equal(phoneToChatId('+62 812-3456-7890'), '6281234567890@c.us');
  assert.equal(phoneToChatId('not a number'), undefined);
  assert.equal(phoneToChatId(undefined), undefined);
});

test('maskChatId keeps only the last four digits', () => {
  assert.equal(maskChatId('6281234567890@c.us'), '***7890@c.us');
  assert.equal(maskChatId('123@c.us'), '***@c.us');
});

test('readConfig throws when no recipient is enabled', () => {
  assert.throws(() => readConfig({}), /No recipients yet/);
  assert.throws(() => readConfig({ users: [] }), /No recipients yet/);
});

test('readConfig drops mapping rows whose number holds no digits', () => {
  const cfg = readConfig({ users: [{ number: 'tbd' }, { number: '+15551234567', seerrUserId: 2 }] });
  assert.equal(cfg.users.length, 1);
  assert.equal(cfg.users[0].chatId, '15551234567@c.us');
});

test('every Now Available section is on, and no config can switch one off', () => {
  const cfg = readConfig(withUser());
  assert.deepEqual(cfg.flags, ALL_SECTIONS);
  assert.ok(Object.values(cfg.flags).every((on) => on === true));

  // The nine show* keys were removed from the schema; a stale value left in a stored config from an
  // older version must not resurrect a disabled section.
  const stale = readConfig(withUser({ showCast: false, showOverview: false, showSeasons: false }));
  assert.deepEqual(stale.flags, ALL_SECTIONS);

  assert.equal(cfg.sendPoster, true);
  assert.equal(cfg.requireMappedUser, true);
  assert.equal(cfg.debug, false);
});

test('enrichment stays off unless the toggle, the URL and the API key are all present', () => {
  assert.equal(readConfig(withUser()).seerr.enabled, false);
  assert.equal(readConfig(withUser({ seerrUrl: 'http://seerr:5055' })).seerr.enabled, false);
  const full = readConfig(withUser({ seerrUrl: 'http://seerr:5055/', seerrApiKey: 'k' }));
  assert.equal(full.seerr.enabled, true);
  // Trailing slash stripped so path concatenation cannot produce a double slash.
  assert.equal(full.seerr.url, 'http://seerr:5055');
});

test('nested user defaults are applied in code, since the host seeds only top-level defaults', () => {
  const cfg = readConfig({ users: [{ number: '+15551234567' }] });
  assert.equal(cfg.users[0].isAdmin, false);
  assert.equal(cfg.users[0].seerrUserId, null);
  assert.equal(cfg.users[0].email, '');
});
