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
import { parseSetupAction } from './setup.ts';

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
    // Owned by the plugin, round-tripped here: ingress URLs, the generated secret, the release check.
    'setup',
    // Stamped by a Setup tab button, cleared by the plugin once the action has run.
    'setupRequestedAt',
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

test('every element the editor script reaches for exists in its markup', () => {
  // 700 lines of HTML that no compiler checks: a renamed id fails at runtime, inside a sandboxed iframe,
  // as a null dereference nobody sees. This is the cheapest possible guard against that.
  const referenced = new Set([...html.matchAll(/\bel\('([^']+)'\)/g)].map((m) => m[1]));
  const present = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

  const missing = [...referenced].filter((id) => !present.has(id));
  assert.deepEqual(missing, [], 'the script reads ids the markup does not define');
});

test('the Setup buttons stamp tokens the plugin actually acts on', () => {
  // The editor's only channel to the plugin is a token string in config. Both halves are written by
  // hand, in different languages, and neither compiler sees the other — so assert them against each other.
  const actions = [...html.matchAll(/requestSetup\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(actions)].sort(), ['instances', 'secret', 'update', 'upgrade']);

  const stamp = /setupToken = action \+ '\|' \+ \(arg \|\| ''\) \+ '\|' \+ new Date\(\).toISOString\(\)/.test(html);
  assert.ok(stamp, 'the token format changed; parseSetupAction has to change with it');

  for (const action of actions) {
    const arg = action === 'secret' ? 'seerr-prod' : '';
    const token = `${action}|${arg}|2026-08-21T12:00:00.000Z`;
    const parsed = parseSetupAction(token);
    assert.equal(parsed?.name, action, `the plugin ignores the token the editor stamps for "${action}"`);
    assert.equal(parsed?.arg, arg);
  }
});

test('the editor script parses', () => {
  // The inline script is never compiled by anything in this repo's toolchain — esbuild bundles index.ts,
  // not the config UI, which ships as-is inside the zip. A syntax error would first be seen by an
  // operator, as a blank panel. `new Function` compiles without executing, which is exactly the check.
  const script = /<script>\n([\s\S]*?)\n<\/script>/.exec(html);
  assert.ok(script, 'could not find the editor script');
  assert.doesNotThrow(() => new Function(script[1]));
});

test('the manifest can reach an operator-hosted Seerr, not only an https one', () => {
  // Proven on a live gateway: with net.allow scoped to a fixed host list, `http://192.168.1.8:5055`
  // was refused as "Plugin seerr-notify may not fetch … add its host to net.allow", and there is no
  // way for an operator to fix that without unzipping the package. net.allowConfigHosts cannot cover
  // it either — the host only admits a config URL when it is https (core plugin-net.ts,
  // effectiveNetAllow), and a self-hosted Seerr on a LAN is almost always plain http.
  //
  // So the allow-list is '*', and the real gate is the host's SSRF guard plus SSRF_ALLOWED_HOSTS,
  // which is the operator's to set. Assert it, because narrowing this back to a host list would
  // silently break every install whose Seerr is not on https.
  const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8')) as {
    net?: { allow?: string[]; allowConfigHosts?: string[] };
  };
  assert.deepEqual(manifest.net?.allow, ['*']);
  assert.deepEqual(manifest.net?.allowConfigHosts, ['jellyseerrUrl']);
});

test('the re-read save cannot clobber what it is waiting for', () => {
  // After a Setup action the editor re-saves purely to make the dashboard re-read config — that is the
  // only lever it has, since the host answers config:get from the plugin list the page already holds.
  // Config writes merge shallowly host-side, so stripping these two keys is what leaves the plugin's
  // fresh write intact. Send the editor's stale copy back instead and the answer is overwritten by the
  // question, and the value never appears at all.
  const body = /function waitForSetupResult\(\) \{([\s\S]*?)\n  \}/.exec(html);
  assert.ok(body, 'could not find waitForSetupResult in the editor');
  assert.match(body[1], /delete cfg\.setup;/, 'the re-read save would overwrite the plugin write-back');
  assert.match(body[1], /delete cfg\.setupRequestedAt;/, 'the re-read save would replay a spent token');
});

test('the Setup tab is the last tab, and not the one the editor opens on', () => {
  // It is a first-run aid; the tabs an operator returns to are Connection and Recipients.
  const tabs = [...html.matchAll(/<button role="tab" id="tab-([a-z]+)"[^>]*aria-selected="(true|false)"/g)];
  assert.deepEqual(
    tabs.map((t) => t[1]),
    ['connection', 'recipients', 'routing', 'options', 'setup'],
  );
  assert.deepEqual(tabs.filter((t) => t[2] === 'true').map((t) => t[1]), ['connection']);
});

test('the editor names the header the manifest actually verifies', () => {
  // Seerr has a dedicated Authorization Header field and sends it verbatim, with no scheme — which is
  // exactly what a shared-secret route compares. Naming a custom header instead cost the operator an
  // extra step for nothing. If the manifest ever moves back to a custom header, the editor has to move
  // with it, or the setup instructions send people to the wrong field.
  const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8')) as {
    ingress: Array<{ signature?: { scheme?: string; header?: string } }>;
  };
  const signature = manifest.ingress[0].signature;
  assert.equal(signature?.scheme, 'shared-secret');
  assert.equal(signature?.header, 'Authorization');
  // The tag is abbreviated to fit the rail; the guide spells the Seerr field out in full.
  assert.match(html, /Auth Header/, 'the Setup tab must name the field the operator fills in');

  const rig = readFileSync(join(HERE, 'send-test.mjs'), 'utf8');
  assert.match(rig, /Authorization: TOKEN/, 'send-test.mjs would 401 against the declared header');
});

test('the editor keeps the interface rules that silently regress', () => {
  // Nothing compiles this file, so these are the rules that break without anyone noticing. Checked
  // against the Web Interface Guidelines the rewrite was reviewed with.
  const markup = html.split('<script>')[0];
  const css = markup.split('</style>')[0];
  const problems: string[] = [];

  // An `outline: none` on :focus outranks a zero-specificity :where(…):focus-visible ring, so keyboard
  // focus disappears on exactly the controls that most need it.
  for (const rule of css.matchAll(/([^{}]+)\{[^}]*outline:\s*none/g)) {
    if (!rule[1].includes(':not(:focus-visible)')) problems.push(`unscoped outline:none → ${rule[1].trim()}`);
  }
  // An icon-only button has no accessible name unless it is given one.
  for (const button of markup.matchAll(/<button(?![^>]*aria-label)[^>]*class="icon"[^>]*>\s*<svg/g)) {
    problems.push(`icon-only button without aria-label at index ${button.index}`);
  }
  for (const svg of markup.matchAll(/<svg(?![^>]*aria-hidden)[^>]*>/g)) {
    problems.push(`decorative svg without aria-hidden at index ${svg.index}`);
  }
  // A placeholder shows the shape of the value; it is not a second label or an instruction.
  for (const placeholder of markup.matchAll(/placeholder="([^"]*)"/g)) {
    if (!placeholder[1].endsWith('…')) problems.push(`placeholder without an ellipsis: ${placeholder[1]}`);
  }
  if (/transition:\s*all/.test(css)) problems.push('transition: all — list the properties');
  if (/\.\.\./.test(markup)) problems.push('literal ... — use …');
  if (/(?<=[A-Za-z])'(?=[A-Za-z])/.test(markup)) problems.push('straight apostrophe — use ’');
  if (!/aria-live="polite"/.test(markup)) problems.push('the status line must announce itself');
  if (!/color-scheme:\s*dark/.test(css)) problems.push('dark theme needs color-scheme for native controls');

  assert.deepEqual(problems, []);
});

test('the icon sheet has no unused symbols and no missing ones', () => {
  // The icons are inlined because the frame's CSP forbids external images. A `<use href="#…">` that
  // resolves to nothing renders as empty space, which is exactly how a missing icon looks in a screenshot.
  const defined = new Set([...html.matchAll(/<symbol id="(i-[a-z-]+)"/g)].map((m) => m[1]));
  const used = new Set([...html.matchAll(/['"]#?(i-[a-z-]+)['"]/g)].map((m) => m[1]));
  assert.deepEqual([...used].filter((name) => !defined.has(name)), [], 'icon used but never defined');
  assert.deepEqual([...defined].filter((name) => !used.has(name)), [], 'icon defined but never used');
});

test('a secret being replaced is never left on screen to be copied', () => {
  // The gap between pressing generate and the new value landing is a few seconds. Showing the old
  // secret through that gap is not a cosmetic problem: it is long enough to copy a credential that is
  // about to stop working into Seerr, and the failure shows up later as 401s on every delivery.
  const render = /function renderSetup\(\) \{([\s\S]*?)\n  \}/.exec(html);
  assert.ok(render, 'could not find renderSetup in the editor');
  assert.match(
    render[1],
    /generating\s*\?\s*''\s*:/,
    'renderSetup must blank the secret while one is being generated, not re-show the previous value',
  );
  assert.match(render[1], /pending && pending\.action === 'secret'/, 'the busy state must key off the in-flight action');

  // The repaint has to happen at both ends: on press (so the stale value goes immediately) and when the
  // action settles (so success reveals the new secret, and failure restores the old one).
  const request = /function requestPlugin\([\s\S]*?\n  \}/.exec(html);
  const finish = /function finishSetup\(\) \{[\s\S]*?\n  \}/.exec(html);
  assert.ok(request && finish, 'could not find the request/finish pair that starts and ends a wait');
  assert.match(request[0], /renderSetup\(\);/);
  assert.match(finish[0], /renderSetup\(\);/);
});

test('every button that waits on the plugin waits the same way', () => {
  // The roster refresh used to run its own path and tell the operator to reload the page, while the
  // Setup buttons repainted themselves. One mechanism, one signal (`setup.lastAction`), one repaint.
  const starts = [...html.matchAll(/requestPlugin\(([^,]+), '([a-z]+)'/g)].map((m) => m[2]);
  const viaSetup = [...html.matchAll(/requestSetup\('([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(starts.concat(viaSetup))].sort(), ['instances', 'roster', 'secret', 'update', 'upgrade']);

  // The plugin has to echo the roster token the same way it echoes a Setup token, or the editor waits
  // for a signal that never comes and falls back to "reload the dashboard".
  const plugin = readFileSync(join(HERE, 'index.ts'), 'utf8');
  assert.match(plugin, /lastAction: `roster\$\{'\$'\}\{token\}`|lastAction: `roster\|\$\{token\}`/);
});

test('the API key is shown from the mirror, and never wiped when it is not', () => {
  // The host replaces a stored secret with SECRET_SENTINEL ('***') before config reaches this frame, so
  // the real key comes from the plugin's mirror — `setup.seerrApiKey` — the same way the ingress secret
  // does. The sentinel path still has to work: on an install whose mirror has not been written yet the
  // field is empty while a key IS stored, and saving an empty string there would erase it.
  const script = html.split('<script>')[1];
  assert.match(script, /var SECRET_SENTINEL = '\*\*\*';/, 'the sentinel must match the host');
  assert.match(
    script,
    /cfg\.setup && typeof cfg\.setup\.seerrApiKey === 'string' \? cfg\.setup\.seerrApiKey : ''/,
    'the displayed key must come from the mirror, since the redacted one can never be shown',
  );
  assert.match(
    script,
    /if \(cfg\.jellyseerrApiKey === '' && apiKeySaved\) cfg\.jellyseerrApiKey = SECRET_SENTINEL;/,
    'with no mirror yet, an untouched key must round-trip as the sentinel or saving wipes it',
  );

  // And the plugin has to keep that mirror current, without the write it makes looping back on itself.
  const plugin = readFileSync(join(HERE, 'index.ts'), 'utf8');
  assert.match(plugin, /if \(previous\.seerrApiKey === stored\) return;/, 'the mirror must stop when it agrees');
});

test('both credentials are the same control', () => {
  // The complaint that produced this: the Setup tab had a rail with reveal and copy, and Connection had
  // a bare input, so the two credentials of the same plugin looked like two different products.
  const markup = html.split('<script>')[0];
  const script = html.split('<script>')[1];

  for (const id of ['jellyseerrUrl', 'jellyseerrApiKey', 'ingressSecret', 'webhookUrl']) {
    const field = new RegExp(`<div class="rail">[\\s\\S]{0,600}?id="${id}"`);
    assert.match(markup, field, `${id} must sit in a rail like every other machine value`);
  }
  // One reveal implementation, bound twice — not two that can drift apart.
  assert.match(script, /function bindReveal\(/);
  assert.match(script, /bindReveal\('revealSecret', 'ingressSecret', 'secret'\);/);
  assert.match(script, /bindReveal\('revealApiKey', 'jellyseerrApiKey', 'API key'\);/);
});

test('installing an update is offered only when there is one, and never unpinned', () => {
  // The install button replaces the running plugin, so it must not appear speculatively — and the URL it
  // hands the gateway must carry the sha256 the RELEASE published, not one derived from the bytes just
  // downloaded, which would verify nothing.
  const script = html.split('<script>')[1];
  assert.match(
    script,
    /var offer = !!\(update && update\.available && update\.latest !== running\) && !installing && !installed;/,
    'a release equal to the running version is not an update, however stale the stored answer is',
  );
  assert.match(
    script,
    /var running = setup\.version \|\| \(update && update\.current\) \|\| '';/,
    'the panel must state the RUNNING version, not the one that was running when the check ran',
  );
  assert.match(script, /el\('installUpdate'\)\.hidden = !offer;/);
  assert.match(script, /el\('installUpdateOptions'\)\.hidden = !offer;/);

  const check = readFileSync(join(HERE, 'update-check.ts'), 'utf8');
  assert.match(check, /#sha256=\$\{update\.sha256\}/, 'the install URL must carry an integrity pin');
  assert.match(check, /publishes no checksum, so the install cannot be pinned/, 'an unpinned install must be refused');
});

test('hiding an element actually hides it, whatever its class sets', () => {
  // `[hidden]` is `display: none` from the UA sheet, at the bottom of the cascade — so any class rule
  // that sets a display defeats `element.hidden = true`. Five controls were affected before this was
  // stated once, including Install update, which stayed on screen with no update to install.
  const css = html.split('</style>')[0];
  const script = html.split('<script>')[1];
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, 'the global rule is what makes hidden reliable');

  // And it has to cover everything the script hides, so nothing needs its own patch again.
  const hidden = [...script.matchAll(/el\('([^']+)'\)\.hidden/g)].map((m) => m[1]);
  assert.ok(hidden.length > 0, 'expected the script to hide something');
  const patches = [...css.matchAll(/([^\n{]*\[hidden\][^\n{]*)\{/g)].map((m) => m[1].trim());
  assert.deepEqual(patches, ['[hidden]'], 'a per-component [hidden] patch means the global rule is being worked around');
});
