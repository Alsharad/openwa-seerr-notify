import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskChatId, phoneToChatId, readConfig } from './config.ts';
import { CONTENT_SECTIONS, DEFAULT_CONTENT } from './content.ts';

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

test('every section is on until the operator switches one off', () => {
  const cfg = readConfig(withUser());
  assert.deepEqual(cfg.content, DEFAULT_CONTENT);
  assert.ok(Object.values(cfg.content).every((on) => on === true));

  // A config written before the Message content tab existed carries no `content` key at all, and was
  // running with everything on. Upgrading must not thin anyone's messages out.
  const legacy = readConfig(withUser({ showCast: false, showOverview: false }));
  assert.deepEqual(legacy.content, DEFAULT_CONTENT);

  const trimmed = readConfig(withUser({ content: { showCast: false, showTrailer: false } }));
  assert.equal(trimmed.content.showCast, false);
  assert.equal(trimmed.content.showTrailer, false);
  // Sections the patch does not name keep the default rather than falling to false.
  assert.equal(trimmed.content.showOverview, true);

  // Junk in the stored object is ignored, not coerced: only a real boolean moves a switch.
  const junk = readConfig(withUser({ content: { showCast: 'no', nonsense: true } }));
  assert.deepEqual(junk.content, DEFAULT_CONTENT);
  assert.deepEqual(Object.keys(junk.content).sort(), [...CONTENT_SECTIONS].sort());

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
