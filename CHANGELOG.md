# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this plugin adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.20.0] - 2026-08-21

### Added

- **A "Send a test message" button on the Setup tab**, because Seerr's own Test button cannot be made to
  work twice. OpenWA dedupes ingress on `(pluginId, instanceId, providerDeliveryId)` behind a UNIQUE
  constraint, and with no delivery-id header from the provider that id is
  `sha256(pluginId ∥ instanceId ∥ route ∥ rawBody)`. A Seerr test payload carries no id and no timestamp,
  so every press is byte-identical and the second one onward is answered `200 duplicate` before this
  plugin is invoked — while Seerr still reports success. There is no setting on either side that changes
  it: the dedup has no per-route opt-out, and Seerr sends no header whose value varies.

  So the button does not go through ingress at all. It is not a webhook, so there is nothing to dedupe.
  It runs the same `processEvent` a real delivery runs — session resolution, recipient routing, message
  formatting, retrying send — using the payload captured byte-for-byte from a live Seerr test press, and
  reports which masked chat ids it reached. What it does not cover is the webhook hop itself, the URL and
  the Authorization header; a real Seerr notification proves that, and the health check reports on it.

  It reports "nobody to send a test to" as a configuration problem rather than a failure of the button:
  a test is routed to admins, so the usual cause is that nobody ticked on the Recipients tab is a Seerr
  admin.


## [1.19.0] - 2026-08-21

### Fixed

- **The "Who gets what" table no longer offers a control that cannot do anything.** `TEST_NOTIFICATION`'s
  **User** cell was a live toggle, but a test payload names no requester, so `matchUser` can never resolve
  one and the setting was decorative in either position. It now renders as not-applicable, the way the
  Admin info cell for that row already did.
- **Not-applicable and switched-off are no longer the same glyph.** Both rendered as a dash, so a cell
  that *cannot* apply looked like one somebody had turned off. Not-applicable now reads `n/a`.
- Corrected the recipient de-duplication comment, which claimed the opposite of what the code does: a
  requester who is also an admin is kept as the **requester** and gets the plain message. That is the
  right way round — they are being told about their own request — but the comment made correct code look
  broken.

### Documentation

- **Setup** now says that Seerr's **Test Notification** button works exactly once, and what to use
  instead. OpenWA answers a repeat of a byte-identical delivery with `200 duplicate` before the plugin is
  ever invoked, and a Seerr test payload carries no id and no timestamp, so every press after the first is
  silently dropped while Seerr still reports success. The README had documented this since the test rig
  was written; the GUI, which is what an operator actually reads, had not.


## [1.18.0] - 2026-08-21

### Fixed

- **Deliveries no longer die when the ingress instance names no session.** The plugin now resolves the
  sending session per delivery: the instance's binding is used when it has one, and otherwise the single
  connected session is. This is the failure that let a fully configured install dead-letter every
  notification as `no_session` while the health check stayed green.

  The binding is close to unsettable from the dashboard, which is why an unbound instance is the normal
  state rather than an unlucky one: the field is free text labelled *"Session scope (optional)"* with the
  placeholder *"Leave blank for all sessions"*, it is stored verbatim with no lookup, and the Sessions
  page shows only `session.id.substring(0, 12)` with no copy control — so the id an operator would paste
  is not obtainable from the UI at all.

  The fallback applies **only when exactly one session is ready**, which is what makes it a determination
  and not a guess: with one ready session there is no other session it could have meant. A binding to a
  ready session always wins; a binding to a session that exists but is not ready fails and says why,
  rather than silently sending from a different one; two or more ready sessions with no binding fails and
  names them. This reverses a deliberate decision from an earlier release — the reasoning then was that
  the host already answers this question, and the half of it that held up (never contradict the instance)
  is preserved exactly.

- **A binding to a deleted session recovers instead of rotting.** Re-pairing a WhatsApp session mints a
  new id, which silently invalidates a stored binding. That case now falls back and logs every time it
  does, since it only works while one session is connected.

### Added

- The health check reports which session deliveries will go out from, and fails when an instance cannot
  send at all — no ingress instance, no connected session, or an ambiguity needing a binding. Previously
  it looked only at the Seerr connection, so the whole outbound half was invisible.

### Documentation

- **Setup** no longer tells operators to bind a session, which was advice the UI could not carry out. It
  says to leave **Session scope** blank instead.
- New README section, **Which session sends**, covering the resolution order and each failure.


### Documentation

- Repository hygiene, no behaviour change: `package.json` carries `repository` / `homepage` / `bugs` /
  `keywords`; `.gitignore` covers `.env*`, editor directories and `*.sha256` rather than one named file;
  and the maintainer's real LAN address is out of the tracked files, replaced by the `192.168.1.50`
  placeholder the docs already used.
- Corrected two Security claims that had gone stale: the Seerr API key is **not** stored masked any more
  (1.12.0 mirrors it so the panel can show it), and Seerr authenticates through its Authorization Header
  field rather than a custom one. A security section that contradicts the configuration section is worse
  than one that says nothing.
- Dropped the CI badge. Actions are disabled on this repository for billing reasons, so every run fails
  in seconds without executing anything — a red badge over code that passes. **Build from source** says
  so instead.
- Removed the instruction to reload the page after Refresh from Seerr; the list has repainted in place
  since 1.9.0. Host placeholders read `<openwa-host>:<openwa-port>` everywhere, matching the panel.

## [1.17.0] — 2026-08-21

### Removed

- **The Setup tab no longer mirrors the Instances tab.** It showed the webhook URL, the ingress secret and
  a generate button — all of which OpenWA's own **Instances** tab already shows *live*, with copy buttons,
  a session picker and a regenerate action. Mirroring them made a cache, and a cache in this panel can
  never be right: the config editor is a sandboxed iframe with no network, so it can only ever display
  what the plugin wrote the last time it ran. Creating an instance left the page stale through browser
  reloads, and no amount of refreshing on this side could have fixed it.

  Setup is now a static guide — where to get the URL and secret, and exactly what to paste where in Seerr.
  Nothing on it can go out of date, and nothing on it has to be kept in step with a tab this plugin does
  not control.

  Gone with it: `discoverInstances`, `rotateSecret`, the `instances` and `secret` actions, and the
  `instances` / `instancesAt` / `secret` / `secretFor` / `secretAt` config state. **The plugin no longer
  stores your ingress secret anywhere** — one fewer credential in config, and one fewer thing to justify
  in Security.

### Changed

- The update banner and the release check stay, because that state is genuinely this plugin's own and has
  nowhere else to live.

## [1.16.0] — 2026-08-21

### Changed

- **The no-instance state is three sentences and a button.** The `curl` command is gone. OpenWA's own
  **Instances** tab owns creating these — it has the id field, the session picker and the
  secret-shown-once view — and restating its instructions here only created a second description to keep
  in step with a tab this plugin does not control. It names the tab and gets out of the way.

### Fixed

- **The instance list no longer goes stale until somebody finds the button.** It is a cache, and
  instances are created on a tab the plugin never hears about, so creating one left the Setup tab empty
  through browser reloads — the cache was correct, just old. The plugin now re-reads the list on any
  config change, and writes only when it has actually changed, so the panel heals itself the next time
  anything is saved.
- **An instance bound to no WhatsApp session is now called out.** It reaches this panel looking perfectly
  healthy — the URL renders, the secret works, the health check passes — and then every delivery
  dead-letters with `no_session`, because there is nowhere to send from. The Setup tab says so, and the
  README's create step says to bind one.

## [1.15.4] — 2026-08-21

### Fixed

- **“No ingress instance yet” sent people to a terminal for something the dashboard has a form for.**
  OpenWA's own **Instances** tab — in the same window as this panel, two tabs across — creates one from
  an id, a session picker and a secret it shows once. The Setup tab was handing out a `curl` command with
  an admin API key instead, which is how a first-time user got stuck on that message.

  It now says what an instance is (the address Seerr posts to), names the tab that makes one, and notes
  that the secret it shows is the same secret, so the Generate step below can be skipped. The `curl` is
  still there for anyone driving the API, relabelled *Or run*. The README step matches.

## [1.15.3] — 2026-08-21

### Documentation

- **Corrected a wrong claim in *Reaching a self-hosted Seerr*.** It said some OpenWA builds do not enforce
  the SSRF guard and reach a LAN address without `SSRF_ALLOWED_HOSTS`. They do enforce it — the guard has
  applied to `ctx.net.fetch` since the capability was introduced, and nothing in OpenWA's changelog
  changes that between 0.23.0 and 0.23.1.

  The reasoning behind the claim was faulty: a gateway that reached a LAN Seerr with no such variable in
  `docker inspect`. OpenWA also reads its own `.env` — `/app/data/.env.generated` in the standard
  container — and the variable was set there. `docker inspect` showing nothing is not evidence it is
  unset, and the section now says so.

  The behaviour is therefore uniform: a private Seerr address needs `SSRF_ALLOWED_HOSTS` on every build.

## [1.15.2] — 2026-08-21

### Fixed

- **The commonest first-run failure now says what to do about it.** A self-hosted Seerr is nearly always
  on a LAN, and OpenWA's SSRF guard refuses private addresses until the operator opts in. A tester got:

  > Cannot reach `http://192.168.8.25:5055` — Blocked internal address: 192.168.8.25. Check the address,
  > and SSRF_ALLOWED_HOSTS if it is a private one. No recipients yet — tick someone on the Recipients tab…

  Correct, and close to useless: it names the address twice, quotes a rule rather than a remedy, mentions
  the variable without the value, and then appends an unrelated problem. It now reads:

  > OpenWA blocks private addresses, so it will not call `http://192.168.8.25:5055`. Set
  > `SSRF_ALLOWED_HOSTS=192.168.8.25` in the gateway's environment and restart it.

  The value is taken from the URL's host, so a hostname URL gets `SSRF_ALLOWED_HOSTS=seerr.lan` — the
  guard matches what the URL says, not what it resolves to.

- **A failed connection is reported on its own.** The recipients note is only appended when the
  connection is sound; someone whose Seerr is unreachable has one problem to solve, and burying that
  sentence under a second one helps nobody.

### Documentation

- *Reaching a self-hosted Seerr* leads with the private-address case, with a `docker-compose.yml` snippet,
  the comma-separated form for several hosts, and why `SSRF_ALLOWED_HOSTS` is the right lever rather than
  `WEBHOOK_SSRF_PROTECT=false`, which disables the guard for every plugin on the host.

## [1.15.1] — 2026-08-21

### Fixed

- **“Recipient list updated” with an empty list.** The refresh worked every time — the gateway log shows
  `roster refreshed: 25 Seerr account(s)` — and then the panel overwrote it. After an action the editor
  re-saves to force the dashboard to re-read config, and that save carried the whole form minus `setup`;
  the editor's roster was still the empty one it had loaded, so it landed straight back on top of the 25
  accounts the plugin had just written.

  The probe now sends `{}`. Shallow merge means an empty patch changes nothing while still triggering the
  re-read, which was the entire job. Naming keys to strip is what failed here — `setup` was stripped and
  `seerrRoster` was not — so there is no longer a list to keep in step.

- **Saving no longer answers in red about recipients.** Saving the Options tab replied “Saved. Tick a
  recipient and add their number” in the failure colour — another tab's business, reported as a problem,
  after a save that had in fact succeeded. Nothing in this panel gates a save, and nothing calls a
  completed one a failure. The Recipients tab counts who will be notified; the health check says the
  same. Neither needed repeating on a Save.

## [1.15.0] — 2026-08-21

### Changed

- **The health verdict is the Seerr connection, and nothing else.** A fresh install with a working Seerr
  and no recipients mapped yet reported *Health Check Failed*, which is wrong twice over: an unfinished
  setup is not a fault, and it is the normal state of every new install. It is also already obvious on
  the Recipients tab, which counts how many people will be notified — it does not need a health check to
  discover.

  The connection is what an operator genuinely cannot check by looking: a wrong address or a rejected key
  produces no visible symptom until a notification quietly arrives bare. So that decides the badge, and
  an empty recipient list joins dead letters as something the message reports without flipping it — the
  policy dead letters have had since 1.0.0 and that this had been contradicting.

  The message is unchanged: *“Seerr v3.4.1 No recipients yet — tick someone on the Recipients tab and add
  their WhatsApp number.”* Only the verdict is.

- Added `health.test.ts` covering the policy in both directions, since it has now moved twice.

## [1.14.1] — 2026-08-21

### Fixed

- **An installed-but-not-enabled plugin looked like a broken one.** Every button in the panel works by
  saving a token for the plugin to act on, and the host only forwards config changes to a plugin whose
  status is ENABLED — so before you press Enable, Check now writes a token nobody is listening for, the
  Updates line reads “Version unknown · never checked”, and the eventual timeout says “Still running —
  reload the dashboard”, which is wrong in the least helpful way.

  The panel has no plugin-status signal, but `setup.version` is a good proxy: the background pass writes
  it on enable, so an empty one means the plugin has never run. Updates now reads **“Not running yet —
  enable the plugin on its card”**, and a timed-out action says **“No answer — is the plugin enabled?”**

## [1.14.0] — 2026-08-21

### Changed

- **The health check says `Seerr v3.4.1` and stops.** It used to say
  `Seerr 3.4.1 at http://192.168.1.50:5055 — API key accepted`, which restated three things the operator
  could already see: the dashboard renders its own success icon and title, and the address is what they
  typed on the previous tab. The message now carries the one fact that toast cannot.
- Every failure message was rewritten to the same standard — name the address (on a failure it *is* the
  thing to check), the reason, and the fix, without the endpoint paths and status-code parentheses that
  only meant something to whoever wrote the probe. “no Seerr URL configured” became
  “Add your Seerr address on the Connection tab.”
- The unreachable-host message no longer tells operators to add a `net.allow` entry. That advice went
  stale in 1.9.0 when the manifest moved to `["*"]`, and it was sending people to edit a file inside the
  package. A test now asserts it against the source, so it cannot come back.

## [1.13.1] — 2026-08-21

### Fixed

- **With more than one ingress instance, the Setup tab only ever showed the first one's webhook URL.**
  The instance id is a path segment in that URL, so two instances mean two URLs; the picker selected only
  which instance got a new secret. It now selects which instance the tab is about, URL included.

### Documentation

- Spelled out that **`seerr-prod` is a name you pick**, not part of the address. It becomes a path
  segment — `/api/ingress/seerr-notify/<your-instance-id>/seerr` — so every example that says
  `seerr-prod` means "whatever you called it", and the Setup tab reads the real URL back from the gateway
  rather than composing one. `send-test.mjs` says the same about its default.

## [1.13.0] — 2026-08-21

### Changed

- **It is called Seerr everywhere now.** “Overseerr/Jellyseerr” is gone from the panel, the manifest, the
  health messages and the docs — the two share a webhook payload and an API, and naming both every time
  said nothing the reader needed. The README states once, up front, that Seerr means either flavour.
- **The config keys are renamed to match**: `jellyseerrUrl` → `seerrUrl`, `jellyseerrApiKey` →
  `seerrApiKey`. Leaving the API spelling at `jellyseerr*` while the interface said Seerr was exactly the
  kind of split this rename exists to remove.

  **Nothing to do on upgrade.** Both spellings are read, so an install keeps working the moment the new
  version starts; the first background pass moves the values across and blanks the old pair. Only a
  script or backup that writes `jellyseerrUrl` / `jellyseerrApiKey` directly needs updating — those keys
  are still read, but they are no longer where the value lives.

  `net.allowConfigHosts` follows the rename, so a Seerr URL keeps being auto-admitted.

- The `overseerr` and `jellyseerr` **keywords are deliberately kept** in `manifest.json` and
  `package.json`. They are search terms, not prose: dropping them would make the plugin undiscoverable to
  someone looking for the product they actually run.

## [1.12.0] — 2026-08-21

### Changed

- **The Connection tab uses the same control as the Setup tab.** Both credentials are now a rail —
  `[label] [value] [actions]` — with the same reveal and copy buttons, driven by one implementation bound
  twice rather than two that can drift. The bare labelled-input styling is deleted, so every value the
  operator types or copies (server address, API key, webhook URL, ingress secret, recipient filter) is
  the same control with the same habits. The Setup tab’s guide link moves inside its card, since it was
  the one rail floating outside one.
- **The API key is shown, not hidden.** The plugin mirrors it into `setup.seerrApiKey`, exactly as it
  already surfaced the ingress secret, because the host redacts `jellyseerrApiKey` to `***` before config
  reaches the panel — which is why the field first showed three characters and then nothing at all. The
  trade is written up under *Both credentials are readable in `setup`* in the README: an admin API key can
  read both in the clear, and `mirrorSeerrKey` can be deleted if you would rather it could not.

## [1.11.2] — 2026-08-21

### Fixed

- **Install update stayed on screen with no update to install** — and it was not alone. `[hidden]` is
  `display: none` from the browser’s own stylesheet, which sits at the very bottom of the cascade, so any
  class rule setting a display — `.btn { display: inline-flex }` — silently defeats `element.hidden =
  true`. Five controls were affected: both install buttons, the release-notes link, the SAVED badge and
  the recipient table.

  The rule is now stated once, `[hidden] { display: none !important }`, replacing four per-component
  patches that had accumulated one bug at a time. A test asserts the global rule exists and that no
  component has gone back to patching itself around it.

## [1.11.1] — 2026-08-21

### Fixed

- **A saved API key looked like a missing one.** The gateway redacts stored secrets before the config
  reaches the panel, so the field is empty whether or not a key is saved — and it sat under a placeholder
  reading “paste your Seerr API key…”, with a line of grey text below saying “A key is saved.” Two
  elements telling opposite stories. The label now carries a **SAVED** badge, the placeholder states the
  action (“saved — type a new key to replace it…”), and the line below goes back to its one job: where to
  find the key in Seerr.

## [1.11.0] — 2026-08-21

### Changed

- **An install now reports that it finished, instead of telling you to reload and hope.** The worker that
  starts an install does not survive it, so the token landing only ever meant *started*. The panel now
  waits for the second landing — the replacement writing its own version and clearing the install marker
  — and says **“Version 1.11.0 installed. Reload the dashboard to load it.”** The replacement reports in
  ~1.5 s after an install rather than on the usual 10 s background pass, because a panel reading
  “installing…” makes ten seconds of silence look like a hang.

### Fixed

- **The banner and Options contradicted each other**, one reading “you are running 1.9.0” while the other
  said 1.10.1, two inches apart. The banner was reading `update.current` — the version that was running
  when the *check* ran, which after an install is the old one. Everything now reads `setup.version`, the
  running build, and a release equal to it is not offered as an update however stale the stored answer is.
- **The banner sentence was spliced from three elements** with static text wedged between them, so an
  install rendered as “Installing version 1.10.1 is out — you are running 1.10.1. — reload the dashboard
  in a few seconds.” It is one string now, composed in one place.
- **“Press again to install” never went away**, and ate the button’s icon on the way: `textContent =`
  wipes child elements, and nothing rebuilt it. Both buttons now have their face rebuilt on every render.
- Both install buttons hide while an install is running, so there is nothing to press twice.

## [1.10.2] — 2026-08-21

### Fixed

- **The update banner survived the update.** A stored check is answered against whatever version was
  running when it ran — which, after an in-place install, is the old one. So the banner went on offering
  a release that was already installed, and the log said “version 1.10.1 is available (running 1.10.1)”,
  until the daily throttle let another check through. The background pass now re-decides the stored
  result against the version actually running: same fetched `latest`, no network call, so the throttle
  cannot skip it.

## [1.10.1] — 2026-08-21

### Fixed

- **Install it could not read the checksum, so it refused to install.** Found by pressing the button on a
  live gateway: it fetched the published `seerr-notify.zip.sha256` sidecar through `ctx.net.fetch`, and a
  GitHub release asset URL answers `302` — which that fetch refuses by design, since following redirects
  is how an allow-listed host becomes a way to reach one that is not. It failed closed, which is the
  right direction, but it failed every time.

  The pin now comes from `assets[].digest` in the release response the check already makes: the sha256
  **GitHub computed for those bytes**. No second request, no redirect to refuse, and a hash that neither
  this plugin nor the release notes can get wrong. A release whose asset carries no digest is refused
  rather than installed unpinned.

## [1.10.0] — 2026-08-21

### Added

- **Install an update from the panel.** The banner grows an **Install it** button, and Options an
  **Install update** button beside Check now. Both take two presses. This exists because there is no UI
  path otherwise: the dashboard’s upload button creates rather than replaces (`Plugin "seerr-notify" is
  already installed`), and its in-place Update button only appears for plugins in OpenWA’s remote
  catalog, which a side-loaded plugin is not.

  It calls `POST /plugins/:id/update`, which **keeps your config, recipients and enabled state** — unlike
  uninstall-then-install. Two properties make it safe to sit behind a button: the URL comes from the
  release feed of the repository baked into the manifest at build time, never from config; and it is
  pinned to the `sha256` the release publishes beside the zip, not one computed from the bytes just
  downloaded, which would verify nothing. A release without a published checksum is refused rather than
  installed unpinned.

  The ordering is the design: that endpoint unloads the plugin making the call, so the state is written
  first — carrying the version being installed — and the replacement clears the marker on its next
  background pass. A success never gets to report itself; a failure leaves the worker alive to write why.

### Documentation

- The README and both release pages now distinguish first install from upgrading, and show the
  `#sha256=` integrity pin. A gateway with `PLUGIN_INSTALL_REQUIRE_PIN` refuses an unpinned URL, which
  is not obvious from the error until you have hit it.

## [1.9.2] — 2026-08-21

### Fixed

- **A saved Seerr API key displayed as three characters.** The host replaces a stored secret with its
  redaction sentinel — literally `***` — before the config reaches the panel, and the panel put that
  straight into the field. It now leaves the field empty and says “A key is saved. Type a new one to
  replace it.” underneath, sending the sentinel back on save so the host keeps the stored value. That
  round trip is not cosmetic: an empty field submitted as an empty string would have erased the key the
  panel never showed you.

## [1.9.1] — 2026-08-21

### Changed

- **The panel says less.** Every switch carried two lines explaining how it worked internally — caption
  byte limits, buffer names, what each log line contains. That is reference material, and it now lives in
  the config table in the README, where someone looking for it can find it. On screen each control gets a
  label and, only where the label cannot carry it, one short line:
  - “Record events that reach nobody” → **Flag notifications with no recipient** · Shown by the health check.
  - “Check GitHub once a day” → **Check for updates daily** · Shows a banner. Never installs anything.
  - The Options tab’s opening paragraph, which listed nine things you cannot change, is gone.
  - The Updates line is now facts separated by dots: `Version 1.9.1 · up to date · checked 7:26 PM`.
- The **Admin info** explanation moved under the routing matrix, next to the column it explains, instead
  of being restated in the tab’s opening paragraph.

## [1.9.0] — 2026-08-21

### Removed

- **The fallback WhatsApp session.** Which session to send from is the host’s to decide — bind the
  ingress instance under **Configure → Instances**. A plugin-side fallback was a second answer to a
  question the host already answers, and sending from a session other than the one the instance names is
  worse than failing. An unbound instance now dead-letters with the fix in the reason. A stale
  `fallbackSessionId` in an existing config is ignored.

### Added

- The **Updates** section states the running version, when it last checked, and whether daily checks are
  on. The plugin records its version on every background pass, so the panel can report it even when the
  release check is switched off or GitHub is unreachable.

### Fixed

- **The health check called a missing Seerr connection healthy**, describing it as “notifications send
  without media detail”. That was left over from when enrichment was optional; since 1.8.0 the connection
  is what the recipient list is built from, so an install without one cannot notify anybody. It reports
  unhealthy, and names the tab to fix it in.
- **An unreadable update timestamp crashed the Setup tab.** `Intl.DateTimeFormat` throws a `RangeError`
  on an invalid Date, which took the whole render with it and left the panel blank.
- **Refresh from Seerr told you to reload the page** while every other button repainted itself. All four
  now share one mechanism: the plugin echoes the token into `setup.lastAction` when the work settles, and
  the panel updates in place. A refresh that fails now reports its reason in the panel rather than only
  in the gateway log.
- `rosterSyncedAt` was parsed into the plugin’s config and read by nothing. Removed from the parsed type.
- The **Record events that reach nobody** switch promised a failure “you can see” with nowhere to see it.
  It now names the health check, which is where those failures are actually reported.
- `package.json` sat at 1.5.0 through three releases. The build now fails when it disagrees with the
  manifest, the same way it already did for the changelog.

## [1.8.1] — 2026-08-21

### Fixed

- **Generating a secret left the previous one on screen, copyable, for the few seconds until the new one
  landed.** That gap was long enough to copy a credential that had already stopped working into Seerr and
  then watch every delivery 401. The field now empties the moment you confirm, the copy and reveal
  buttons go with it, and the generate icon spins until the new value arrives. A failed or timed-out
  generate puts the previous secret back rather than leaving the field blank.

## [1.8.0] — 2026-08-21

### Removed — action required

- **The Seerr URL and API key are required now, and `enrichmentEnabled` is gone.** The recipient list is
  read from Seerr, so a Seerr account is the only thing that can be mapped to a WhatsApp number — a
  plugin without a connection has nobody to deliver to, and an “enrichment off” mode only ever produced
  thinner messages for no gain. A delivery whose Seerr call fails still goes out from the payload alone;
  that is a degraded call, not a mode. **Any install that had the toggle off will start enriching again.**
- **The per-recipient delete button is gone.** Seerr owns the list, so a row cannot be added or removed
  here — untick someone to stop notifying them. An account that has left Seerr keeps its row, badged
  `NOT IN SEERR`, so a mapping is never silently dropped.

### Changed

- Recipients are a real table with **User / ID / Phone number** headers, instead of a stack of cards.
- Updates get their own section on the Options tab, with the daily-check switch and Check for updates
  together rather than a switch in one card and a button in another.
- The Setup tab’s secret is labelled **Auth Header**, which is what fits the rail.
- The Who gets what tab drops its admin tally — it restated what the Recipients tab already shows.

### Fixed

- **The reveal button showed two eyes.** The icon swap replaced `button.firstChild`, which is the
  whitespace text node before the indented `<svg>` — so the original icon stayed and a second was
  inserted beside it. Icon swaps now target the `<svg>` itself, which also fixes the copy button's
  check-mark never swapping back.

## [1.7.0] — 2026-08-21

### Changed

- **The config panel is rebuilt.** One component vocabulary now runs through every tab, so Connection,
  Recipients, Who gets what, Options and Setup are visibly the same product:
  - **The rail** — `[label] [value] [actions]` in a recessed row — carries the webhook URL, the secret,
    the recipient filter and the create-instance command. Modelled on Seerr’s own API-key control, which
    is what the operator has open in the next tab.
  - The secret behaves like Seerr’s API key: masked by default, with reveal, copy and regenerate icons.
    **The Clear button is gone** — Seerr stores it in the clear anyway, and clearing it here only meant
    generating a new one to see it again.
  - Every machine value — URLs, secrets, event names, Seerr ids, phone numbers — is set in mono with
    tabular figures, so the routing matrix and the recipient list scan as columns.
  - Icons are one inline SVG set (the frame’s CSP allows no external image or font requests).
- **The webhook URL no longer grows a scrollbar.** It truncates with an ellipsis, carries the full value
  in its tooltip, and Copy takes the whole thing.
- **The full guide is a link**, not a field to copy from. A sandboxed frame has no `allow-popups`, so the
  click tries `window.open` and falls back to putting the URL on the clipboard rather than doing nothing.
- Recipient rows show a live count (“3 of 25 will be notified”), and clearing one takes two presses,
  since a cleared mapping cannot be recovered from the panel.

### Fixed

- Keyboard focus was invisible on every text input: an `outline: none` on `:focus` outranked the
  zero-specificity `:focus-visible` ring. Scoped to pointer focus only.
- Tabs are now arrow-key navigable, panels are focusable, icon-only buttons carry `aria-label`, the
  status line announces itself (`aria-live`), and the dark theme sets `color-scheme` so native controls
  and scrollbars match.

## [1.6.0] — 2026-08-21

### Added

- **A Setup tab** — the last tab, since it is a first-run aid and the tabs an operator returns to are
  Connection and Recipients. It shows the exact webhook URL to paste into Seerr, read back from the
  gateway's own instance list rather than assembled by hand, the header name, and the walkthrough of what
  to set in Seerr and what to leave alone.
- **Generate a new secret.** The gateway reveals an ingress secret exactly once, in the response to the
  call that mints it, so the editor cannot read the existing one back. This rotates the instance secret
  and shows the plaintext with a Copy button, behind a two-click confirm because rotating breaks the
  running webhook until the new value reaches Seerr. Clear it once Seerr has it.
- A Setup action now shows its result in place. The plugin writes its answer to config a moment after the
  save that asked for it, and the dashboard answers the editor from the plugin list it already holds — so
  the editor re-saves (stripped of the keys the plugin owns, which shallow-merge leaves alone) to make the
  dashboard re-read, then re-reads. Measured on a live gateway: all three actions land in under 0.3 s, so
  one re-read is enough and generating a secret no longer means reloading the page.
- **An update banner.** Once a day the plugin asks GitHub whether a newer release exists, and the editor
  shows a banner with the release URL if so. Nothing is downloaded or installed. `updateCheckEnabled`
  switches the check off entirely, and "Check now" runs it on demand.

### Changed — action required

- **Seerr authenticates with the `Authorization Header` field now, not a custom header.** Seerr sends that
  field verbatim, with no scheme, which is exactly what a `shared-secret` route compares — so the custom
  header was an extra step for nothing, and the gateway does not touch `Authorization` on a `@Public()`
  ingress route (verified against a live instance). **Existing installs: move the secret out of the custom
  header row into Authorization Header and delete the custom header, or every delivery 401s.**
  `send-test.mjs` moved with it.

  If something in front of OpenWA rewrites or strips `Authorization`, change
  `ingress[0].signature.header` in the manifest to a header it leaves alone.

- The Setup tab is down to what you actually paste: the webhook URL, the Authorization value with a
  Generate button, one line about the JSON payload and notification types, and a link to the full guide.
  The instance count, the session-scope note, the "read from OpenWA at …" timestamp and the always-on
  Refresh button are gone — the list re-reads itself when the plugin starts, and a "Check again" button
  appears only while there is no instance to show.

### Fixed

- **A fresh install could not be set up.** `onEnable` threw when no recipient was mapped, which marks the
  plugin ERROR — and the host does not deliver config changes to a plugin in ERROR. That stranded the
  install: "Refresh from Seerr" and every Setup button work by saving a config change, and they are how a
  first recipient comes to exist. The condition is now logged and reported by `healthCheck` instead, and
  a delivery with nothing to deliver to is dropped with a reason rather than throwing per webhook.
- The editor no longer refuses to save until a recipient exists — a first-run operator has to save a
  Seerr URL and API key *before* a roster refresh can find anyone to map. It warns instead.

- The health check now tests the Seerr connection **before** it looks at the recipient list, so "test my
  Seerr settings" works on a fresh install. It previously returned `no recipients enabled` and never
  probed — which is the wrong order: you connect Seerr, fetch the roster, and only then map anyone.
- `net.allow` is now `["*"]`. Verified on a live gateway: with a fixed host list, a Seerr on
  `http://192.168.1.50:5055` was refused with `Plugin seerr-notify may not fetch …`, and there was no way
  to fix it without unzipping the package — `net.allowConfigHosts` only admits a config URL when it is
  **https**, and a self-hosted Seerr almost never is. The real gate stays the host's SSRF guard and
  `SSRF_ALLOWED_HOSTS`, which the operator controls.

### Changed

- The plugin reaches `api.github.com` for the release check. It is the only host it contacts that is not
  the operator's own Seerr, and `updateCheckEnabled: false` stops it entirely.
- The loopback self-call that lets the plugin write its own config moved into `gateway.ts`, shared by the
  roster refresh and the Setup tab. Same mechanism, same constraints, one implementation.

## [1.5.0] — 2026-08-21

### Added

- **The "Who gets what" matrix is now editable.** Click any ✓ / — to flip it, so each operator decides
  which Seerr events reach the requester, which reach admins, and which admin copies carry the Admin
  Info block. "Reset to defaults" restores the shipped routing.
- `MEDIA_AVAILABLE`, `MEDIA_AUTO_APPROVED` and `MEDIA_AUTO_REQUESTED` can now carry an Admin Info block
  (the requester lines). They previously fell through to no block at all, which was fine while the block
  was hardcoded per event — but a toggle the operator can switch on has to produce something.

### Changed

- Routing moved out of `resolveRecipients`' hardcoded branches into a `routing` config table. Current
  behaviour is the default, so an existing install is unaffected until a cell is flipped; a partial or
  older config layers over the defaults rather than blanking them.
- `TEST_NOTIFICATION`'s Admin Info cell renders as not-applicable rather than as a toggle: a test event
  carries no requester, no reporter and no ids, so the block would be an empty heading.

## [1.4.0] — 2026-08-21

### Added

- **"Refresh from Seerr" button** in the Recipients tab. The editor cannot fetch anything itself, so the
  button stamps a token and saves; the plugin sees the changed token in `onConfigChange`, fetches the
  Seerr user list and writes the roster back into its own config. `refresh-roster.mjs` still works and
  remains the option that needs no elevated access.
- Recipient rows are compact and single-line — `☑ name [ADMIN] id phone ✕` — with a filter box, an
  "Enabled only" toggle, and a per-row delete (clears the mapping; removes the row outright when the
  Seerr account is gone).

### Changed

- Email is no longer rendered in the recipient list. It is still cached for fallback matching and is
  still searched by the filter — it was 24 lines of clutter in a list that needed scanning.
- `NOT IN SEERR` is only shown once a roster is actually cached. With none, every row carried the flag,
  which read as data loss rather than "the roster has not been fetched yet".

### Security

- The refresh button reads the gateway's admin key from its key file (`/app/data/.api-key`) to call
  `PUT /api/plugins/:id/config`, because nothing in the plugin capability surface can write config —
  **this steps outside the capability model by design, at the operator's request**. The key is never
  copied into config and never leaves the process; the self-call is loopback-only and goes through
  Node's `fetch` rather than `ctx.net.fetch`, so admitting it does not open loopback to every plugin on
  the host via `SSRF_ALLOWED_HOSTS`. The write sends only the three roster keys, and the host merges
  config shallowly, so the operator's other settings — the Seerr API key included — are untouched.

## [1.3.0] — 2026-08-21

### Added

- **Recipients are now picked from your Seerr user list.** `refresh-roster.mjs` caches every Seerr
  account into plugin config; the Recipients tab renders one row per account with its display name,
  email and an ADMIN badge. Enabling someone and giving them a WhatsApp number is the whole mapping.
- Admin status is read from Seerr's `Permission.ADMIN` bit instead of a manual per-row toggle, so it
  cannot drift from Seerr.
- A row whose Seerr account has since disappeared (or predates the first refresh) is still rendered,
  flagged `NOT IN SEERR`, so a stale roster never silently discards a mapping.

### Changed

- The routing table lists the real `notification_type` constants (`MEDIA_PENDING`, `ISSUE_COMMENT`, …)
  rather than prose labels.
- A mapping row is now `{ seerrUserId, number, enabled }`. Identity and admin status come from the
  roster; a pre-1.3 row that carries `email` / `username` / `isAdmin` still resolves from those values
  when the roster has no entry for its id, so upgrading drops no recipients.

### Notes

- The refresh is a **command, not a button, and never automatic**. The config editor runs in an
  opaque-origin sandbox with no network whose only channel speaks `config:get` / `config:save`, and a
  plugin cannot write its own config — so the roster has to be written by something holding an OpenWA
  admin key.

## [1.2.0] — 2026-08-21

### Added

- A `configUi` editor replacing the generated form, organised into four tabs: **Connection**,
  **Recipients**, **Who gets what**, **Options**.
- A **Who gets what** routing matrix: one row per Seerr event, with columns for the requester/reporter,
  admins, and whether the admin copy carries the Admin Info section. A test parses the table and checks
  every row against `resolveRecipients` / `formatMessages`, so it cannot drift from the code.
- The Recipients tab reports how many mapped users are admins, and warns when none are — the case where
  admin-only events (including Test notification) silently reach nobody.

### Removed

- The nine per-field `show*` toggles. Every Now Available section is always on. Nine switches for one
  message type was more configuration surface than the decision warranted; a stale `show*` value left in
  a stored config is ignored rather than honoured.

## [1.1.0] — 2026-08-21

### Added

- `healthCheck` now probes the configured Seerr instance, so the dashboard's existing health-check
  button doubles as a "test my settings" action. It reports the Seerr version on success and
  distinguishes the failure modes that look alike from the config form: an unreachable host (naming
  `net.allow` and `SSRF_ALLOWED_HOSTS`, the two allowlists that usually cause it), a URL that answers
  but is not Seerr, and an API key the instance rejected.

### Changed

- A broken Seerr configuration now reports **unhealthy**. Dead letters are still appended to the health
  message as context but never flip the verdict — one failed send is not a broken plugin.

## [1.0.0] — 2026-08-21

### Added

- Ingress route `seerr`, authenticated with a `shared-secret` header (`X-Seerr-Token`) — the only scheme
  Seerr's webhook agent can satisfy, since it sends static custom headers and cannot compute an HMAC.
- Recipient routing per event type: requester + admins for `MEDIA_PENDING` / `MEDIA_APPROVED` /
  `MEDIA_DECLINED` / `MEDIA_FAILED`, requester only for `MEDIA_AVAILABLE` / `MEDIA_AUTO_APPROVED` /
  `MEDIA_AUTO_REQUESTED`, reporter + admins for every `ISSUE_*`, admins only for `TEST_NOTIFICATION`.
- User mapping as dashboard-editable config (`users` array-of-rows), matched to the Seerr actor by user
  id, then email, then username.
- Message formatting for every Seerr event type, with an `Admin Info` section appended for admin
  recipients on admin-relevant events.
- Optional Seerr API enrichment (overview, ratings, runtime, genres, director/creator, top cast,
  trailer, season status, collection) with nine per-field toggles.
- Poster delivery: attached as the image caption when the message fits WhatsApp's 1024-character
  caption limit, otherwise sent as an uncaptioned image followed by the text.
- Bounded dead-letter buffer in `ctx.storage` (one key, newest 50 entries) covering malformed payloads,
  unmapped events, missing sessions and failed sends; surfaced through `healthCheck`.
