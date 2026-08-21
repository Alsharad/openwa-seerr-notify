# Seerr Notifications → WhatsApp

> Deliver Overseerr/Jellyseerr request and issue notifications over WhatsApp. Seerr's webhook is verified
> host-side against a shared secret, enriched from the Seerr API, routed to the right people from a user
> mapping, and formatted per recipient — with an extra Admin Info block for administrators.

![type: extension](https://img.shields.io/badge/type-extension-blue.svg)
![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![built for OpenWA](https://img.shields.io/badge/OpenWA-%E2%89%A5%200.8.16-25D366.svg)
[![CI](https://github.com/Alsharad/openwa-seerr-notify/actions/workflows/ci.yml/badge.svg)](https://github.com/Alsharad/openwa-seerr-notify/actions/workflows/ci.yml)

An [OpenWA](https://github.com/rmyndharis/OpenWA) plugin. Built against the conventions in that
project's [plugin standard](https://github.com/rmyndharis/OpenWA-plugins/blob/main/PLUGIN-STANDARD.md).

| | |
| --- | --- |
| **Plugin id** | `seerr-notify` |
| **Requires** | OpenWA ≥ 0.8.16 (Integration SDK v1) · tested 0.23.1 |
| **Tested against** | Jellyseerr / Seerr 3.4.1 |
| **Permissions** | `webhook:ingress` · `conversation:send` · `net:fetch` · `storage:use` |
| **Ingress route** | `seerr` — shared-secret header (`X-Seerr-Token`) |

## Features

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
  `X-Seerr-Token` header against the instance secret in constant time before the plugin runs, and a
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

1. **Have a WhatsApp session running** in OpenWA, and note its session id.
2. **Create a Seerr API key** (Jellyseerr/Overseerr → Settings → General → API Key) if you want
   enrichment. Without it the plugin still delivers, using only what the webhook payload contains.
3. **Allow the Seerr host for outbound calls**, if you want enrichment. Two gates apply, and a
   self-hosted Seerr on a private address needs both:
   - **`net.allow`** in this plugin's `manifest.json`. `net.allowConfigHosts` already admits
     `jellyseerrUrl` automatically, but **only when it is an `https` URL** — a plain-`http` LAN address is
     ignored, so add the host yourself: `"net": { "allow": ["192.168.1.50:5055"], ... }`.
   - **`SSRF_ALLOWED_HOSTS`** in the OpenWA environment. The host's SSRF guard blocks every RFC1918
     address regardless of `net.allow`: `SSRF_ALLOWED_HOSTS=192.168.1.50`.

   Get either wrong and enrichment silently no-ops — messages still arrive, without the detail. The
   plugin logs `Seerr API request failed` when this is the cause.
4. **Install the plugin** (below), open **Configure → Recipients**, hit **Refresh from Seerr**, reload
   the page, then enable the people you want and give them WhatsApp numbers. Enabling the plugin fails
   with `no recipients enabled` until at least one is — it has nothing to do otherwise.
5. **Provision an ingress instance** and copy the secret it returns (shown **once**):

   ```bash
   curl -X POST http://<openwa-host>:2785/api/integration/plugins/seerr-notify/instances \
     -H "X-API-Key: <ADMIN_KEY>" -H 'Content-Type: application/json' \
     -d '{"instanceId":"seerr-prod","sessionScope":"<your-session-id>"}'
   ```

   The response carries `secret` and the `ingressUrls[].url` for the `seerr` route. `CreateInstanceDto`
   is strictly validated — an extra field such as `enabled` is rejected with a `400`. When `BASE_URL` is
   unset the URL comes back relative; prefix it with your own host.
6. **Point Seerr at it** — Jellyseerr/Overseerr → Settings → Notifications → Webhook:
   - **Webhook URL**: the `ingressUrls[].url` from step 5
     (`http://<openwa-host>:2785/api/ingress/seerr-notify/seerr-prod/seerr`)
   - **Custom header**: key `X-Seerr-Token`, value the `secret` from step 5
   - Leave the default JSON payload template as-is, and tick the notification types you want.

## Install

Download `seerr-notify.zip` from [Releases](https://github.com/Alsharad/openwa-seerr-notify/releases),
then either drop it into the dashboard (**Plugins → Install plugin**) or upload it over the API:

```bash
curl -X POST http://<openwa-host>:2785/api/plugins/install \
  -H "X-API-Key: <ADMIN_KEY>" -F 'file=@seerr-notify.zip'

curl -X POST http://<openwa-host>:2785/api/plugins/seerr-notify/enable \
  -H "X-API-Key: <ADMIN_KEY>"
```

Then open **Configure** and work through the tabs — Connection, Recipients, Who gets what, Options.
Enabling fails until at least one recipient is enabled with a WhatsApp number, which is deliberate: the
plugin has nothing to do without one.

### Testing it

Seerr's own **Test Notification** button is a poor test rig: it only ever sends `TEST_NOTIFICATION`, so
it exercises none of the formatting that matters, and its payload is byte-identical every time — which
collides with OpenWA's ingress de-duplication (no delivery-id header ⇒ the id is a hash of the body), so
the second press and every one after it is answered `200 duplicate` and never reaches the plugin. That
dedup is doing real work — it is what stops a crash-recovery replay or a DLQ redrive from messaging
people twice — so the answer is a better test rig, not weaker dedup.

```bash
export SEERR_INGRESS_TOKEN=<instance secret>
export INGRESS_URL=http://<openwa-host>:2785/api/ingress/seerr-notify/seerr-prod/seerr

node send-test.mjs --list                        # every event type
node send-test.mjs                               # TEST_NOTIFICATION (admins)
node send-test.mjs MEDIA_AVAILABLE --as alice    # poster + enrichment, to a requester
node send-test.mjs ISSUE_COMMENT --as alice
```

Each run carries a `_nonce`, so it is always a fresh delivery and never deduplicated. `--as` is the
Seerr username or email the event comes from; it must match a mapped, enabled recipient, since every
event except `TEST_NOTIFICATION` is routed to its requester or reporter by default.

### Build from source

```bash
npm ci
npm run check      # typecheck + tests + package
```

`npm run build` writes `seerr-notify.zip`. Releases are cut by tagging `v<x.y.z>` — CI builds the zip,
attaches it with a checksum, and the manifest version must match the top CHANGELOG heading or the build
fails.

## Configuration

Everything here is edited from the plugin's own config screen (Configure on the Plugins page). The keys
are listed because they are what the REST API and any backup will show you.

| Key | Required | Default | Description |
| --- | -------- | ------- | ----------- |
| `users` | **yes** | `[]` | Recipient mappings, one per notified Seerr account: `{ seerrUserId, number, enabled }`. Identity and admin status come from `seerrRoster`, not from here. Enabling fails while none is enabled with a number. |
| `jellyseerrUrl` | no | `""` | Seerr base URL. Empty disables enrichment. See the two allowlist gates in **Setup**. |
| `jellyseerrApiKey` | no | `""` | Seerr API key (stored masked). Empty disables enrichment. |
| `enrichmentEnabled` | no | `true` | Master switch for Seerr API calls. Enrichment needs this **and** a URL **and** a key. |
| `requireMappedUser` | no | `true` | On: an event matching nobody is recorded as a delivery failure. Off: dropped quietly. |
| `fallbackSessionId` | no | `""` | Session to send from when the ingress instance is not bound to one. |
| `sendPoster` | no | `true` | Attach the poster to `MEDIA_AVAILABLE` / `MEDIA_PENDING`. |
| `routing` | no | *(defaults)* | Per-event delivery rules — `{ EVENT: { user, admin, adminInfo } }`. Edited in **Who gets what**; unset events use the shipped defaults. |
| `seerrRoster` | no | `[]` | Cached Seerr accounts (`{ id, name, email, isAdmin }`) so the editor can list them. Written by the Refresh button or `refresh-roster.mjs`. |
| `rosterSyncedAt` | no | `""` | ISO timestamp of the last roster refresh. |
| `rosterRefreshRequestedAt` | no | `""` | Token stamped by the Refresh button; changing it is what asks the plugin to refetch. Not edited by hand. |
| `debug` | no | `false` | Log one line per delivery with masked chat ids. Never logs message bodies. |

Every **Now Available** section — overview, rating, runtime, genres, director/creator, top cast, trailer,
seasons, collection — is always on. These were nine separate toggles until v1.2.0; that was more
configuration surface than the decision deserved.

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
- **`TEST_NOTIFICATION` goes to admins only**, by default. If no enabled recipient is a Seerr admin, a
  test reaches nobody and is recorded as `no_recipients`; the Recipients tab warns when that is the case.
- **The Refresh button needs the gateway's key file.** It reads `/app/data/.api-key` to write the roster
  back through OpenWA's own API — see **Security**. Where that file is unreadable, use
  `refresh-roster.mjs` instead, which takes the key from the environment.
- **Verified against Jellyseerr/Seerr 3.4.1.** Notably, that build validates `/api/v1/status` query
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
  replayable. This is the strongest scheme Seerr's webhook agent can produce, since it sends fixed custom
  headers and cannot sign. Treat the secret as a credential: prefer HTTPS to the ingress URL, keep the
  route off the public internet where you can, and rotate with
  `POST /api/integration/plugins/seerr-notify/instances/<id>/regenerate-secret` if it leaks.
- **A valid token can trigger WhatsApp sends** to the numbers in your mapping — never to arbitrary
  numbers, since recipients come from operator config and never from the payload.
- **Payload text reaches your users.** Seerr subjects, overviews and issue comments are relayed into
  WhatsApp messages. Control characters are stripped and every field is length-capped, but the content
  itself is whoever wrote it in Seerr.
- **The poster URL is fetched by the host**, through the same SSRF guard as any other media send.
- **Secrets in logs**: the API key is stored masked and never logged; chat ids are masked to their last
  four digits; message bodies are never logged, at any log level.
- **The worker is crash containment, not a security boundary** — as OpenWA's own docs state. Plugin code
  keeps `require('fs')` and raw sockets whatever the manifest declares.
- **⚠️ The Refresh button steps outside the plugin capability model.** Nothing in the supported surface
  lets a plugin write its own config: the editor is an opaque-origin sandbox with no network whose only
  channel speaks `config:get` / `config:save`, and `PluginContext.config` is a read-only getter. The only
  writer is `PUT /api/plugins/:id/config`, which requires an ADMIN, unscoped key. So the button reads the
  gateway's own key from `/app/data/.api-key` and calls that endpoint. Specifically:
  - the key is read at call time, **never copied into config**, never logged, and never leaves the process;
  - the self-call is **loopback-only** and uses Node's `fetch`, not `ctx.net.fetch` — widening
    `SSRF_ALLOWED_HOSTS` to admit `127.0.0.1` would open loopback to *every* plugin on the host;
  - the write sends **only the three roster keys**, and the host merges config shallowly, so no other
    setting (the Seerr API key included) is touched;
  - it is triggered only by an operator clicking the button, never on a timer.

  If you would rather no plugin on your host could do this, delete `roster-refresh.ts` and the
  `onConfigChange` handler in `index.ts` and use `refresh-roster.mjs`, which takes the key from the
  environment of whoever runs it. Everything else works unchanged.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
