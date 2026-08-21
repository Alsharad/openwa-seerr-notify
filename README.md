# Seerr Notifications → WhatsApp

> Deliver Seerr request and issue notifications over WhatsApp. Seerr's webhook is verified
> host-side against a shared secret, enriched from the Seerr API, routed to the right people from a user
> mapping, and formatted per recipient — with an extra Admin Info block for administrators.

![type: extension](https://img.shields.io/badge/type-extension-blue.svg)
![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![built for OpenWA](https://img.shields.io/badge/OpenWA-%E2%89%A5%200.8.16-25D366.svg)

**Seerr** here means either flavour — [Overseerr](https://overseerr.dev) or
[Jellyseerr](https://github.com/fallenbagel/jellyseerr). They share the webhook payload and the API this
plugin uses, so everything below applies to both, and the panel says Seerr throughout.

An [OpenWA](https://github.com/rmyndharis/OpenWA) plugin. Built against the conventions in that
project's [plugin standard](https://github.com/rmyndharis/OpenWA-plugins/blob/main/PLUGIN-STANDARD.md).

| | |
| --- | --- |
| **Plugin id** | `seerr-notify` |
| **Requires** | OpenWA ≥ 0.8.16 (Integration SDK v1) · tested 0.23.1 |
| **Tested against** | Seerr 3.4.1 |
| **Permissions** | `webhook:ingress` · `conversation:send` · `net:fetch` · `storage:use` |
| **Ingress route** | `seerr` — shared-secret in the `Authorization` header |

## Features

- **A Setup tab that does the fiddly parts** — reads the webhook URL back from the gateway so you paste
  rather than assemble it, generates the secret Seerr authenticates with, and says what else to set.
- **Updates itself** — a daily GitHub check raises a banner, and **Install it** replaces the plugin in
  place, keeping your config and recipients. The download is pinned to the sha256 GitHub publishes for
  the release asset. The check switches off in one click; the install always takes two presses.
- **Routing you control** — a clickable matrix of every Seerr `notification_type` against requester,
  admins, and whether admins get the Admin Info block. Defaults to the sensible thing: requesters hear
  about their own requests, admins hear about anything they may need to act on.
- **Recipients picked from your Seerr user list** — hit Refresh from Seerr and every account appears
  with its display name and an ADMIN badge. Enabling someone and giving them a WhatsApp number is the
  whole mapping; admin status is read from Seerr's permission bit, so it cannot drift.
- **Admin Info block** — admin recipients get the same message plus requester/reporter identity and the
  Seerr request/issue ids needed to act on it.
- **Rich Now Available messages** — overview, rating, runtime, genres, director or creator, top five
  cast, trailer link, per-season availability, and collection membership.
- **Poster attached** — sent as the image caption when the message fits WhatsApp's 1024-character
  caption limit, otherwise as an uncaptioned image followed by the text.
- **Host-side authentication** — `signature.scheme: "shared-secret"`; the host compares the
  `Authorization` header against the instance secret in constant time before the plugin runs, and a
  `session-alive` preflight answers 503 when the WhatsApp session is down.
- **Degrades instead of dropping** — a Seerr API that is down, slow or unreachable costs the message its
  enrichment, never its delivery.

## What it does

For each accepted delivery the plugin validates the payload, then hands the work to a background task
and returns. The background task enriches the event from the Seerr API (resolving the requester's Seerr
id, then media details and ratings), resolves recipients from the user mapping, formats one user message
and one admin message, and sends each recipient their variant — retrying a failed send twice with a
1 s / 2 s backoff.

Logging is deliberately quiet: warnings for failures, and — only with `debug` on — one line per delivery
carrying the event type, the resolved recipient count, masked chat ids (last four digits) and per-send
outcomes. **Message bodies and full phone numbers are never logged.**

Deliveries that cannot be completed are recorded in a bounded buffer in plugin storage (one key, newest
50 entries) with reason `invalid_payload`, `no_recipients`, `no_session` or `send_failed`. `healthCheck`
reports the count and the most recent entry.

**What the health badge means.** The verdict is the Seerr connection, and nothing else. That is the one
thing an operator cannot check by looking: a wrong address or a rejected key produces no visible symptom
until a notification quietly arrives bare. Everything else the check knows — an empty recipient list,
recent delivery failures — is reported in the message but never flips the verdict. An unfinished setup is
not a fault, and a badge that goes red for one teaches you to ignore it.

### Why the work is backgrounded

The host dispatches an ingress handler with a **5 second** budget and does **not** cancel the work when
that expires — it records the delivery as failed while the handler keeps running. This notification does
up to three Seerr API calls and then one poster upload per recipient, and the host budgets a *single*
media send at 120 s. Awaiting that inside the handler would produce a false dispatch failure, and a
redrive of it would re-run a handler that had already sent — delivering the notification twice.

The trade is explicit: the host's ingress retry and dead-letter machinery no longer covers delivery,
because the handler has already returned successfully by the time a send can fail. Retries and dead
letters are owned by the plugin instead.

## Setup

Most of this is done for you by the **Setup** tab (the last tab on the config screen). It shows the
webhook URL read back from the gateway, generates the header secret, and spells out what to set in Seerr.
The full path:

1. **Have a WhatsApp session running** in OpenWA.
2. **Create a Seerr API key** (Seerr → Settings → General → API Key). It is required:
   the recipient list is read from Seerr, so a Seerr account is the only thing that can be mapped to a
   WhatsApp number.
3. **Install and enable the plugin** (below). It enables with an empty config — there is nothing to
   configure before it is running, and the buttons that fetch things only work while it *is* running.
4. **Create an ingress instance** on **Configure → Instances → Create**: an id (`seerr-prod` is fine) is
   all it needs. Leave **Session scope** blank — see [Which session sends](#which-session-sends). It shows
   the secret once; keep it. That tab is also where you copy the webhook URL and regenerate a secret
   later, and it always shows the live values.
5. **Open Configure → Connection**, fill in the Seerr URL and API key, and Save. Both are required. Use
   the health-check button on the plugin row to confirm — it reports the Seerr version and whether the
   key was accepted, and it works before any recipient exists.
6. **Configure → Setup** is a short reminder of what to paste where; the values themselves live on the
   Instances tab, since that is what owns them.
7. **Point Seerr at it** — Seerr → Settings → Notifications → Webhook:
   - **Enable Agent**: on
   - **Webhook URL**: the URL from the Setup tab
   - **Authorization Header**: the secret. Seerr sends this field verbatim, with no scheme, which is
     exactly what a `shared-secret` route compares — so no custom header is needed.
   - **JSON Payload**: leave it at Seerr's default — press **Reset to Default** if you have edited it.
     Every field the plugin reads comes from that template. Extra fields are ignored, so a template that
     only *adds* things is fine.
   - Tick the notification types you want. Seerr decides what is sent at all; the **Who gets what** tab
     decides who receives each one.
8. **Configure → Recipients**, press **Refresh from Seerr** and wait a second for the list to appear,
   then tick the people you want and give them WhatsApp numbers. Nothing is delivered until at least one
   recipient exists — the health check says so, and an arriving notification is dropped with that reason
   in the log.

### Which session sends

Deliveries go out from the WhatsApp session bound to the ingress instance — and if the instance names
none, from the one session that is connected.

That fallback exists because the binding is close to unsettable from the dashboard. The field is free
text labelled *"Session scope (optional)"* with the placeholder *"Leave blank for all sessions"*, it is
stored verbatim with no lookup, and the Sessions page renders `session.id.substring(0, 12)` with no copy
control — so the full id you would have to paste is not shown anywhere. The usual result is an unbound
instance, which looks like a healthy install until every delivery dead-letters as `no_session`.

The rule is narrow on purpose: **the fallback applies only when exactly one session is ready.** One ready
session means there is no other it could have meant, so there is no wrong choice available. Beyond that:

- A binding to a ready session always wins. The fallback never overrides an explicit choice.
- A binding to a session that exists but is *not* ready fails, and says which and why. It does not
  quietly send from a different one.
- A binding to a session that no longer exists — deleted, or re-paired, which mints a **new id** — falls
  back and logs that it did. This is the case a stored binding cannot survive on its own.
- Two or more ready sessions with no binding fails and names them. Bind the instance to the one you want.

The health-check button reports which session will send, so an install that cannot deliver says so before
a notification is lost rather than after.

### Reaching a self-hosted Seerr

**If your Seerr is on a private address — anything `192.168.x.x`, `10.x.x.x` or `172.16–31.x.x` — OpenWA
will refuse to call it until you say so.** The health check reports:

> OpenWA blocks private addresses, so it will not call `http://192.168.8.25:5055`. Set
> `SSRF_ALLOWED_HOSTS=192.168.8.25` in the gateway's environment and restart it.

That is the whole fix. Set it on the OpenWA container — the value is the **host as it appears in your
Seerr URL**, with no scheme and no port, and it takes a restart:

```yaml
# docker-compose.yml
services:
  openwa:
    environment:
      - SSRF_ALLOWED_HOSTS=192.168.8.25
```

Several hosts are comma-separated. Use the hostname rather than the address if your URL is a name
(`SSRF_ALLOWED_HOSTS=seerr.lan`) — the guard matches on what the URL says, not on what it resolves to.

This is OpenWA protecting its own network from a plugin that could otherwise be told to fetch anything on
it, so it is worth understanding rather than switching off wholesale: `WEBHOOK_SSRF_PROTECT=false`
disables the guard for **every** plugin on the host, while `SSRF_ALLOWED_HOSTS` opens exactly the one
address you named.

Note that OpenWA reads this from its own `.env` (`/app/data/.env.generated` in the standard container)
as well as the process environment, so `docker inspect` showing no such variable does not mean it is
unset. The health check is the reliable answer: if it reports the Seerr version, the guard is letting
the call through.

**Why `net.allow` is `["*"]`** and not a host list: the host only auto-admits a config URL through
`net.allowConfigHosts` when it is **https** (OpenWA's own `plugin-net.ts`, `effectiveNetAllow`), and a
self-hosted Seerr almost never is. With a fixed list, every such install fails with `Plugin seerr-notify
may not fetch …` and the only fix is unzipping the package to edit the manifest. The real gate stays
where the operator can reach it — the SSRF guard above.

## Install

Download `seerr-notify.zip` from [Releases](https://github.com/Alsharad/openwa-seerr-notify/releases),
then drop it into the dashboard (**Plugins → Install plugin**) or upload it over the API:

```bash
curl -X POST http://<openwa-host>:<openwa-port>/api/plugins/install \
  -H "X-API-Key: <ADMIN_KEY>" -F 'file=@seerr-notify.zip'

curl -X POST http://<openwa-host>:<openwa-port>/api/plugins/seerr-notify/enable \
  -H "X-API-Key: <ADMIN_KEY>"
```

Then open **Configure** and work through the tabs — Connection, Recipients, Who gets what, Options, and
Setup for the Seerr side. The plugin enables with an empty config; the health check and the log tell you
what is still missing.

### Upgrading an existing install

From **v1.10.0** the panel does this for you: when a newer release exists, the banner offers **Install
it**. Everything below is what that button does, and how to do it by hand from an older version.

**Uploading a newer zip is rejected with `Plugin "seerr-notify" is already installed`.** The dashboard's
upload button creates; it does not replace. Its in-place Update button appears only for plugins listed in
OpenWA's remote catalog, which a side-loaded plugin is not. The endpoint that does replace one is
`POST /plugins/:id/update`, and it **preserves your config, your recipients and the enabled state** —
which uninstall-then-install does not:

```bash
# The sha256 is on the release page, next to the zip.
curl -X POST http://<openwa-host>:<openwa-port>/api/plugins/seerr-notify/update \
  -H "X-API-Key: <ADMIN_KEY>" -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/Alsharad/openwa-seerr-notify/releases/download/v<VERSION>/seerr-notify.zip#sha256=<SHA256>"}'
```

The `#sha256=` fragment is an integrity pin. A gateway running with `PLUGIN_INSTALL_REQUIRE_PIN` (the
default in some deployments) refuses an unpinned URL outright:

> installing from a URL requires an integrity pin in this deployment: append `#sha256=<64 hex>` to the URL

Every release ships `seerr-notify.zip.sha256` alongside the zip for exactly this.

### Updates

Once a day the plugin asks GitHub whether a newer release exists, and the config screen shows a banner
with the release URL when there is one. Nothing is downloaded or installed — updating stays your
decision, and the same API call you installed with is how you take it. Switch the check off entirely
with **Options → Check GitHub for new releases**, or run it on demand with **Check now**.

The banner shows the URL rather than a clickable link: the config screen is a sandboxed iframe with no
`allow-popups`, so a link there cannot open anything. Copy it.

### Testing it

> **If you pressed Seerr's Test button and nothing arrived, this is why — it works once.** Use
> **Configure → Setup → Send a test message** instead, which is not a webhook and so is never
> deduplicated. The health-check button on the plugin's row covers the webhook hop it skips.

Seerr's own **Test Notification** button is a poor test rig: it only ever sends `TEST_NOTIFICATION`, so
it exercises none of the formatting that matters, and its payload is byte-identical every time — which
collides with OpenWA's ingress de-duplication (no delivery-id header ⇒ the id is a hash of the body), so
the second press and every one after it is answered `200 duplicate` and never reaches the plugin. That
dedup is doing real work — it is what stops a crash-recovery replay or a DLQ redrive from messaging
people twice — so the answer is a better test rig, not weaker dedup.

```bash
export SEERR_INGRESS_TOKEN=<instance secret>
export INGRESS_URL=http://<openwa-host>:<openwa-port>/api/ingress/seerr-notify/seerr-prod/seerr

node send-test.mjs --list                        # every event type
node send-test.mjs                               # TEST_NOTIFICATION (admins)
node send-test.mjs MEDIA_AVAILABLE --as alice    # poster + enrichment, to a requester
node send-test.mjs ISSUE_COMMENT --as alice
```

Each run carries a `_nonce`, so it is always a fresh delivery and never deduplicated. `--as` is the
Seerr username or email the event comes from; it must match a mapped, enabled recipient, since every
event except `TEST_NOTIFICATION` is routed to its requester or reporter by default.

### When a notification can be silently dropped

OpenWA de-duplicates ingress on `(pluginId, instanceId, providerDeliveryId)`. With no delivery-id header
from the provider, that id is `sha256(pluginId ∥ instanceId ∥ route ∥ rawBody)` — so **two notifications
with byte-identical bodies collide, and the second is answered `200 duplicate` before this plugin runs.**
It stays dropped until the row ages out via `INGRESS_DEDUP_RETENTION_DAYS` (default 7).

Most events are safe, because the default payload carries something that changes:

| Event | Distinguishing field | Safe? |
|---|---|---|
| `MEDIA_*` | `request_id` (Seerr's per-request id) and `requestedBy_*` | yes |
| `ISSUE_CREATED` | `issue_id` | yes |
| `ISSUE_COMMENT` | — | **no** |
| `ISSUE_RESOLVED` / `ISSUE_REOPENED` | `issue_id` + `issue_status` only | **no** |
| `TEST_NOTIFICATION` | — | **no** (see [Testing it](#testing-it)) |

A declined request followed by the same title being requested again — by the same person or a different
one — is **not** a collision: Seerr issues a new `request_id` and never reuses one.

What does collide:

- The same person posting the **same comment text** twice on the same issue ("any update?").
- An issue **resolved, reopened, then resolved again** — the second `ISSUE_RESOLVED` is byte-identical
  to the first.

Neither is fixable here or in Seerr's settings. Seerr's template variable map has no `comment_id`, no
notification id and no timestamp, so there is no varying value to put in the payload or in a custom
header for `dedupHeader` to key on. The fix belongs in the host: a per-route opt-out on
`deriveDeliveryId`, or a coarse timestamp folded into it.

Note that the key includes `instanceId`, so renaming or recreating an ingress instance starts a fresh
de-duplication window.

### Build from source

```bash
npm ci
npm run check      # typecheck + tests + package
```

`npm run build` writes `seerr-notify.zip`. The packaging step is a gate, not just a bundler: it refuses
to build when `manifest.json`, `package.json` and the top released CHANGELOG heading disagree on the
version, when `manifest.main` is missing from the archive, or when the result exceeds OpenWA's 5 MB
install limit.

`.github/workflows/ci.yml` runs the same three commands on every push, and tagging `v<x.y.z>` publishes a
release with the zip and its checksum attached. There is no CI badge above because this repository's
Actions are currently disabled for billing reasons — every run fails in seconds without executing
anything, which would show as a red badge on code that passes. Run `npm run check` locally until that
clears.

## Configuration

Everything here is edited from the plugin's own config screen (Configure on the Plugins page). The keys
are listed because they are what the REST API and any backup will show you.

| Key | Required | Default | Description |
| --- | -------- | ------- | ----------- |
| `users` | **yes** | `[]` | Recipient mappings, one per notified Seerr account: `{ seerrUserId, number, enabled }`. Identity and admin status come from `seerrRoster`, not from here; an account Seerr does not have cannot be added. Untick someone to stop notifying them. Nothing is delivered while none is enabled with a number. |
| `seerrUrl` | **yes** | `""` | Seerr base URL. See *Reaching a self-hosted Seerr*. |
| `seerrApiKey` | **yes** | `""` | Seerr API key. Reads the user list, and fills notifications out. Redacted to `***` on every read, so the panel shows an empty field with “A key is saved” rather than the sentinel; leaving it empty keeps the stored key. |
| `requireMappedUser` | no | `true` | On: an event whose requester or reporter matches no enabled recipient is written to the plugin's dead-letter buffer, and the health check reports the count and the most recent reason. Off: dropped without a trace. Shown in the panel as **Flag notifications with no recipient**. |
| `sendPoster` | no | `true` | Attach the poster to `MEDIA_AVAILABLE` / `MEDIA_PENDING`. Sent as the image caption when the whole message fits WhatsApp's 1024-character caption limit, otherwise as an uncaptioned image followed by the text. |
| `routing` | no | *(defaults)* | Per-event delivery rules — `{ EVENT: { user, admin, adminInfo } }`. Edited in **Who gets what**; unset events use the shipped defaults. `adminInfo` appends a block to the admin copy carrying the requester or reporter's name and email and the Seerr request/issue id. Someone who is both the requester and an admin gets one message — the admin one. |
| `seerrRoster` | no | `[]` | Cached Seerr accounts (`{ id, name, email, isAdmin }`) so the editor can list them. Written by the Refresh button or `refresh-roster.mjs`. |
| `rosterSyncedAt` | no | `""` | ISO timestamp of the last roster refresh. |
| `rosterRefreshRequestedAt` | no | `""` | Token stamped by the Refresh button; changing it is what asks the plugin to refetch. Not edited by hand. |
| `setup` | no | `{}` | Written by the plugin: the running version, the release check, and a mirror of the Seerr API key so the Connection tab can show it. Not edited by hand. No ingress URL or ingress secret — those live on OpenWA's Instances tab, which shows them live. |
| `setupRequestedAt` | no | `""` | Token stamped by **Check for updates** or **Install it** as `<action>\|<arg>\|<timestamp>`, and cleared by the plugin once the action has run. Not edited by hand. |
| `updateCheckEnabled` | no | `true` | Ask `api.github.com` for the latest release once a day, and show a banner when it is newer than the running build. Nothing is ever downloaded or installed. Off = no outbound request is made at all. The check also runs on demand from **Options → Check now**. |
| `debug` | no | `false` | One gateway log line per delivery: event type, resolved recipient count, chat ids masked to their last four digits, and each send's outcome. Message bodies are never logged at any level. Shown in the panel as **Verbose logging**. |

### The Seerr API key is readable in `setup`

`setup.seerrApiKey` mirrors your Seerr API key so the Connection tab can show it. A field flagged
`secret` in the schema reaches the config screen as `***`, so a panel can only ever display a credential
the plugin puts somewhere unredacted — without the mirror that field showed three asterisks, and then an
empty box.

What it costs: an ADMIN, unscoped API key reading `GET /plugins` sees the value in the clear. Everything
that can read it could already do more than read it — that key class can rewrite the config or uninstall
the plugin — and Seerr stores its own copy in the clear regardless. If you would rather it did not,
delete `mirrorSeerrKey` from `index.ts`; the field falls back to an empty box that still saves correctly.

The **ingress secret is not stored here at all** — OpenWA's Instances tab owns it.

Every **Now Available** section — overview, rating, runtime, genres, director/creator, top cast, trailer,
seasons, collection — is always on. These were nine separate toggles until v1.2.0; that was more
configuration surface than the decision deserved, and the panel stopped mentioning them in v1.9.1 for
the same reason: a list of things you cannot change is not a setting.

The panel's own copy is deliberately short — a label, and at most one line where the label cannot carry
it. This table is where the detail lives.

## Compatibility

- **Requires OpenWA ≥ 0.8.16** for Integration SDK v1 (`sdkVersion: "1"`, ingress routes,
  `ctx.conversations.send`). Tested against 0.23.1.
- **Message length.** WhatsApp caps a media caption at 1024 characters and a text message at 4096. A
  Now Available message with every field enabled can exceed 1024 for a long overview or a large cast, in
  which case the poster is sent uncaptioned and the text follows as its own message. Text beyond 4096 is
  split on line boundaries.
- **Duplicate suppression is content-based.** Seerr sends no delivery-id header, so the host derives the
  id from a hash of the request body. Two deliveries with a byte-identical body inside the dedup window
  (`INGRESS_DEDUP_RETENTION_DAYS`, default 7) are treated as a re-delivery and the second is answered
  `200 duplicate` without reaching the plugin. Distinct events almost always differ in body, but
  **pressing Test Notification twice** produces exactly this, and looks like the plugin ignoring you.
- **Retry behaviour depends on your queue.** With `QUEUE_ENABLED=false` (OpenWA's default) ingress
  dispatches inline with a single attempt. It does not matter much here: the plugin backgrounds its own
  delivery, so the host's retry would not have covered the sends anyway. See **Why the work is
  backgrounded**.
- **`TEST_NOTIFICATION` goes to admins only**, by default. If no notified recipient is a Seerr admin, a
  test reaches nobody and is recorded as `no_recipients`, which the health check reports.
- **The Refresh button needs the gateway's key file.** It reads `/app/data/.api-key` to write the roster
  back through OpenWA's own API — see **Security**. Where that file is unreadable, use
  `refresh-roster.mjs` instead, which takes the key from the environment.
- **Verified against Seerr 3.4.1.** Notably, that build validates `/api/v1/status` query
  params against its OpenAPI schema, so the plugin sends `checkUpdateAvailable=false` (an empty value or
  `0` is rejected with a 400). Older Seerr builds coerce the value instead and simply run the update
  check, which is slower but not an error.
- **The end-to-end delivery path is exercised by unit tests with a stubbed capability surface**, not by
  an automated test against a live WhatsApp session.

### Per-session config

Supported. Config is re-read from `ctx.config` on every delivery, so a per-session override resolves to
the right slice and dashboard edits — a new user, a toggled field, a rotated API key — apply without a
restart. Nothing is cached across deliveries.

## Security

- **The ingress route is a `@Public()` endpoint.** Anyone who can reach it can attempt a delivery. What
  stops them is the `shared-secret` comparison against the per-instance secret, done host-side in
  constant time before the plugin runs.
- **`shared-secret` authenticates the caller, not the body.** Unlike an HMAC scheme it does not bind the
  request content, so anyone holding the token can send any payload — and a token in a static header is
  replayable. This is the strongest scheme Seerr's webhook agent can produce: it sends fixed header
  values and cannot sign a request. Treat the secret as a credential: prefer HTTPS to the ingress URL, keep the
  route off the public internet where you can, and rotate with
  `POST /api/integration/plugins/seerr-notify/instances/<id>/regenerate-secret` if it leaks.
- **A valid token can trigger WhatsApp sends** to the numbers in your mapping — never to arbitrary
  numbers, since recipients come from operator config and never from the payload.
- **Payload text reaches your users.** Seerr subjects, overviews and issue comments are relayed into
  WhatsApp messages. Control characters are stripped and every field is length-capped, but the content
  itself is whoever wrote it in Seerr.
- **The poster URL is fetched by the host**, through the same SSRF guard as any other media send.
- **The Seerr API key is readable through the API.** It is mirrored into the `setup` config object so the
  Connection tab can display it — see *The Seerr API key is readable in `setup`* for why, what it costs,
  and the one function to delete if you disagree. It is never logged. The ingress secret is not stored by
  this plugin at all.
- **Secrets in logs**: chat ids are masked to their last four digits, and message bodies are never
  logged, at any log level.
- **The worker is crash containment, not a security boundary** — as OpenWA's own docs state. Plugin code
  keeps `require('fs')` and raw sockets whatever the manifest declares.
- **`net.allow` is `["*"]`**, because the host only auto-admits an `https` config URL and a self-hosted
  Seerr is almost never https — see *Reaching a self-hosted Seerr*. The plugin fetches exactly two kinds
  of host: the Seerr URL you configured, and `api.github.com` for the release check (which you can switch
  off). The SSRF guard still refuses private addresses unless `SSRF_ALLOWED_HOSTS` says otherwise.
- **⚠️ The plugin can replace itself.** The Install button calls `POST /plugins/seerr-notify/update`
  with the gateway's own admin key, which unloads the running plugin and installs a new package. The
  chain that makes that acceptable: the download URL comes from the GitHub release feed of the repository
  baked into the manifest **at build time** — never from config, so no config write can redirect it — and
  it is pinned to the sha256 GitHub publishes for the asset itself (`assets[].digest`), so the hash is
  neither computed from the downloaded bytes nor transcribed by hand. A release whose asset carries no
  digest is refused. If you would rather this did not exist, delete `installUpdate` from `setup.ts`; the check
  and the banner keep working, and `Options → Check GitHub` switches off the check entirely.
- **⚠️ The Refresh button and the Setup tab step outside the plugin capability model.** Nothing in the
  supported surface lets a plugin write its own config: the editor is an opaque-origin sandbox with no
  network whose only channel speaks `config:get` / `config:save`, and `PluginContext.config` is a
  read-only getter. The only writer is `PUT /api/plugins/:id/config`, which requires an ADMIN, unscoped
  key. So the plugin reads the gateway's own key from `/app/data/.api-key` and calls that endpoint —
  `gateway.ts` is the whole of it. Specifically:
  - the key is read at call time, **never copied into config**, never logged, and never leaves the process;
  - the self-call is **loopback-only** and uses Node's `fetch`, not `ctx.net.fetch` — widening
    `SSRF_ALLOWED_HOSTS` to admit `127.0.0.1` would open loopback to *every* plugin on the host;
  - the write sends **only the keys that action owns**, and the host merges config shallowly, so no other
    setting (the Seerr API key included) is touched;
  - every action is operator-triggered, with one exception: a single background pass ~10 s after the
    plugin is enabled, which reads the ingress instance list and (at most once a day, and only while
    `updateCheckEnabled` is on) checks GitHub. It writes nothing when it has nothing.

  It also means anything the plugin can be made to write, it writes as an admin. That is why the Setup
  action token is validated as one of three literal names with a pattern-checked instance id, and why the
  token is cleared rather than echoed — a stale `secret|…` left in config would otherwise rotate your
  ingress secret again after an unrelated restart.

  If you would rather no plugin on your host could do this, delete `gateway.ts`, `setup.ts`,
  `roster-refresh.ts` and the `onConfigChange` handler in `index.ts`, and use `refresh-roster.mjs`, which
  takes the key from the environment of whoever runs it. You lose the Setup tab and the update banner;
  everything on the delivery path works unchanged.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
