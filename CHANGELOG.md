# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this plugin adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
  `http://192.168.1.8:5055` was refused with `Plugin seerr-notify may not fetch …`, and there was no way
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
