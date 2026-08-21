# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this plugin adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
