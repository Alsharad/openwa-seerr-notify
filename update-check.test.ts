import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginNetResponse } from './types/openwa';
import { checkForUpdate, isNewer, repoSlug } from './update-check.ts';

const NOW = () => new Date('2026-08-21T12:00:00.000Z');

const reply = (status: number, body: unknown): PluginNetResponse => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: '',
  headers: {},
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('a GitHub repository URL reduces to owner/repo', () => {
  assert.equal(repoSlug('https://github.com/Alsharad/openwa-seerr-notify'), 'Alsharad/openwa-seerr-notify');
  assert.equal(repoSlug('https://github.com/Alsharad/openwa-seerr-notify.git'), 'Alsharad/openwa-seerr-notify');
  assert.equal(repoSlug('https://github.com/Alsharad/openwa-seerr-notify/'), 'Alsharad/openwa-seerr-notify');
  assert.equal(repoSlug('git@github.com:Alsharad/openwa-seerr-notify.git'), 'Alsharad/openwa-seerr-notify');
  assert.equal(repoSlug('https://gitlab.com/someone/else'), '', 'only GitHub releases are checked');
  assert.equal(repoSlug(''), '');
});

test('version comparison only claims an update when there really is one', () => {
  assert.equal(isNewer('1.6.0', '1.5.0'), true);
  assert.equal(isNewer('v1.6.0', '1.5.0'), true, 'a leading v is a tag convention, not part of the version');
  assert.equal(isNewer('1.5.1', '1.5.0'), true);
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
  assert.equal(isNewer('1.10.0', '1.9.0'), true, 'numeric, not lexicographic');

  assert.equal(isNewer('1.5.0', '1.5.0'), false);
  assert.equal(isNewer('1.4.0', '1.5.0'), false, 'never offers a downgrade');
  assert.equal(isNewer('1.5', '1.5.0'), false, 'a missing component reads as zero');
  assert.equal(isNewer('1.6.0-rc.1', '1.6.0'), false, 'a pre-release never supersedes the release');
  assert.equal(isNewer('1.6.0', '1.6.0-rc.1'), true, 'but the release supersedes its own pre-release');

  // A banner that cries wolf gets ignored, so anything unparseable answers "no update".
  assert.equal(isNewer('', '1.5.0'), false);
  assert.equal(isNewer('latest', '1.5.0'), false);
  assert.equal(isNewer('1.6.0', '0.0.0-dev'), true, 'an un-bundled dev build still gets told');
});

test('a newer release is reported with its release page', async () => {
  const state = await checkForUpdate(
    async (url) => {
      assert.equal(url, 'https://api.github.com/repos/o/r/releases/latest');
      return reply(200, { tag_name: 'v1.6.0', html_url: 'https://github.com/o/r/releases/tag/v1.6.0' });
    },
    'o/r',
    '1.5.0',
    NOW,
  );

  assert.equal(state.available, true);
  assert.equal(state.latest, '1.6.0');
  assert.equal(state.current, '1.5.0');
  assert.equal(state.url, 'https://github.com/o/r/releases/tag/v1.6.0');
  assert.equal(state.checkedAt, '2026-08-21T12:00:00.000Z');
});

test('being current is stated, not left blank', async () => {
  const state = await checkForUpdate(async () => reply(200, { tag_name: 'v1.5.0' }), 'o/r', '1.5.0', NOW);
  assert.equal(state.available, false);
  assert.equal(state.note, 'up to date');
  assert.equal(state.url, 'https://github.com/o/r/releases', 'falls back to the releases index');
});

test('a repository with no releases is not an error', async () => {
  // GitHub answers 404 for a repository whose releases page is empty — which is the state this plugin's
  // own repository was in when the checker was written.
  const state = await checkForUpdate(async () => reply(404, { message: 'Not Found' }), 'o/r', '1.5.0', NOW);
  assert.equal(state.available, false);
  assert.equal(state.note, 'no releases have been published yet');
});

test('every failure mode answers, and none of them throws', async () => {
  const cases: Array<[() => Promise<PluginNetResponse>, string]> = [
    [async () => reply(403, ''), 'GitHub rate-limited the check; it will retry later'],
    [async () => reply(500, ''), 'GitHub answered HTTP 500'],
    [async () => reply(200, 'not json'), 'GitHub returned a response this could not read'],
    [async () => reply(200, { tag_name: '' }), 'the newest release carries no tag'],
    [
      () => Promise.reject(new Error('net.fetch host not allowed')),
      'could not reach GitHub: net.fetch host not allowed',
    ],
  ];

  for (const [fetchFn, expected] of cases) {
    const state = await checkForUpdate(fetchFn, 'o/r', '1.5.0', NOW);
    assert.equal(state.available, false);
    assert.equal(state.note, expected);
  }
});

test('a plugin built without a GitHub repository says so instead of fetching', async () => {
  let called = false;
  const state = await checkForUpdate(
    async () => {
      called = true;
      return reply(200, {});
    },
    '',
    '1.5.0',
    NOW,
  );
  assert.equal(called, false);
  assert.equal(state.note, 'no GitHub repository is declared in the manifest');
});
