# Seerr Notifications → WhatsApp

> Sends Overseerr/Jellyseerr request and issue notifications to WhatsApp, routed to the right people and
> formatted per recipient.

![type: extension](https://img.shields.io/badge/type-extension-blue.svg)
![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)
![built for OpenWA](https://img.shields.io/badge/OpenWA-%E2%89%A5%200.8.16-25D366.svg)

An [OpenWA](https://github.com/rmyndharis/OpenWA) plugin. **Seerr** means either flavour —
[Overseerr](https://overseerr.dev) or [Jellyseerr](https://github.com/fallenbagel/jellyseerr); they share
the webhook and API this uses.

| | |
| --- | --- |
| **Plugin id** | `seerr-notify` |
| **Requires** | OpenWA ≥ 0.8.16 · tested 0.23.1 · Seerr 3.4.1 |
| **Permissions** | `webhook:ingress` · `conversation:send` · `net:fetch` · `storage:use` |

```
✅ Now Available
*PAW Patrol: The Movie (2021)*
⭐ 7.3/10  |  ⏱ 88 min

_Ryder and the pups are called to Adventure City._

🎭 Animation, Family
```

## Install

Download `seerr-notify.zip` from [Releases](https://github.com/Alsharad/openwa-seerr-notify/releases),
then **Plugins → Install plugin** in the dashboard, and enable it. It starts with an empty config — the
health check on the plugin row tells you what is still missing.

After that it updates itself: a daily check raises a banner, and **Install it** replaces the plugin in
place, keeping your settings. See [Upgrading](#upgrading) for doing it by hand.

## Setup

1. **Get a Seerr API key** — Seerr → Settings → General. Required: your recipient list is read from
   Seerr, so a Seerr account is the only thing that can map to a WhatsApp number.
2. **Create an ingress instance** — OpenWA → Configure → Instances → Create. An id (`seerr-prod`) is all
   it needs. **Leave Session scope blank.** It shows a secret once — keep it.
3. **Configure → Connection** — paste the Seerr URL and API key, Save. Then press the health check on the
   plugin row; it reports your Seerr version if the connection works.
4. **Point Seerr at it** — Seerr → Settings → Notifications → Webhook:
   - **Enable Agent**: on
   - **Webhook URL**: from the Instances tab
   - **Authorization Header**: the secret, pasted as-is — no `Bearer`, no prefix
   - **JSON Payload**: leave at Seerr's default (press **Reset to Default** if you have edited it)
   - Tick the notification types you want
5. **Configure → Recipients** — press **Refresh from Seerr**, tick people, add their WhatsApp numbers.
   Nothing is delivered until at least one recipient exists.

The **Setup** tab reminds you of steps 2 and 4 with the live values in front of you.

## What you can configure

Six tabs on the plugin's **Configure** screen:

| Tab | What it does |
| --- | --- |
| **Connection** | Seerr URL and API key. Both required. |
| **Recipients** | Your Seerr users, pulled live. Tick someone, give them a number. Admin status comes from Seerr's own permission bit. |
| **Who gets what** | Every Seerr event against requester / admins / whether admins get the extra **Admin Info** block. |
| **Message content** | Which sections a media notification carries — see below. |
| **Options** | Dead-letter flagging, verbose logging, update checks. |
| **Setup** | A reminder of what to paste into Seerr. |

### Message content

Every switch is on by default. A section is left out when Seerr has nothing for it regardless, so
switching one off is the difference between *not available* and *not wanted*.

| Switch | In the message | Notes |
| --- | --- | --- |
| Poster | The artwork | Sent as the image caption, or as its own image when the text is too long |
| Plot summary | The overview, in italics | Also affects **Request Submitted** |
| Rating | `⭐ 7.1/10` | IMDb, else Rotten Tomatoes, else TMDB |
| Runtime | `⏱ 100 min` | Shares a line with Rating |
| Release date | `📅 2004-11-10` | **Off** folds the year into the title instead — `*PAW Patrol: The Movie (2021)*` |
| Genres | `🎭 Animation, Family` | Also affects **Request Submitted** |
| Cast | A **Cast** block | Top five billed |
| Director | `🎬 Robert Zemeckis` | The creator, for a series |
| Trailer link | `🎥 https://youtu.be/…` | First YouTube trailer Seerr lists |
| Season list | A **Seasons** block | Series only, with per-season availability |
| Collection | `🎬 Part of: …` | Movies only |

Only the two media messages have sections to switch. Approvals, declines, failures and issue events are
a headline and a sentence.

<details>
<summary><b>Every config key</b> — what the REST API and a backup will show you</summary>

| Key | Default | Description |
| --- | --- | --- |
| `users` | `[]` | Recipient mappings: `{ seerrUserId, number, enabled }`. Identity and admin status come from `seerrRoster`. Nothing is delivered while none is enabled with a number. |
| `seerrUrl` | `""` | **Required.** Seerr base URL. |
| `seerrApiKey` | `""` | **Required.** Redacted to `***` on every read; leaving the field empty keeps the stored key. |
| `routing` | *(defaults)* | `{ EVENT: { user, admin, adminInfo } }`. Unset events use the shipped defaults. Someone who is both requester and admin gets one message — the admin one. |
| `content` | *(all on)* | The Message content switches, minus the poster. An unset section is included. |
| `sendPoster` | `true` | The poster switch. Top-level rather than a `content` section, so an existing setting is never re-read from a different place. |
| `requireMappedUser` | `true` | On: an event matching no recipient is recorded as a dead letter and reported by the health check. Off: dropped silently. |
| `updateCheckEnabled` | `true` | Ask GitHub for the latest release once a day. Off = no outbound request at all. |
| `debug` | `false` | One log line per delivery: event type, recipient count, chat ids masked to their last four digits. Message bodies are never logged, at any level. |
| `seerrRoster`, `rosterSyncedAt`, `rosterRefreshRequestedAt`, `setup`, `setupRequestedAt` | | Written by the plugin. Not edited by hand. |

</details>

## Troubleshooting

| Symptom | Why | Fix |
| --- | --- | --- |
| Seerr's **Test Notification** worked once, then never again | Its payload is byte-identical every time, and OpenWA de-duplicates on the request body | Use **Configure → Setup → Send a test message**, which is not a webhook and can be pressed repeatedly |
| Health check: *OpenWA blocks private addresses* | The gateway refuses to call a LAN address until told otherwise | Set `SSRF_ALLOWED_HOSTS` — see below |
| Everything dead-letters as `no_session` | The ingress instance is not bound to a session, and more than one is connected | Bind it on the Instances tab, or run one session |
| Notifications arrive bare, with no poster or detail | The Seerr connection is failing, so nothing enriches them | Press the health check; it reports what Seerr said |
| A test reaches nobody | `TEST_NOTIFICATION` goes to admins only | Tick a Seerr admin on **Recipients** |
| The same repeated issue comment never arrives twice | Identical bodies collide in the host's de-duplication | Not fixable here — see below |

<details>
<summary><b>Reaching a self-hosted Seerr</b> — the SSRF setting, in full</summary>

If your Seerr is on a private address — `192.168.x.x`, `10.x.x.x`, `172.16–31.x.x` — OpenWA will refuse
to call it until you say so. Set this on the **OpenWA** container and restart it:

```yaml
# docker-compose.yml
services:
  openwa:
    environment:
      - SSRF_ALLOWED_HOSTS=192.168.8.25
```

The value is the host **as it appears in your Seerr URL**, no scheme and no port. Several are
comma-separated. Use the hostname if your URL is a name — the guard matches what the URL says, not what
it resolves to.

This is OpenWA protecting its own network from a plugin that could otherwise be told to fetch anything on
it, so it is worth understanding rather than switching off wholesale: `WEBHOOK_SSRF_PROTECT=false`
disables the guard for **every** plugin on the host, while `SSRF_ALLOWED_HOSTS` opens exactly the address
you named.

OpenWA also reads this from its own `.env` (`/app/data/.env.generated`), not only the process
environment — so `docker inspect` showing nothing does not mean it is unset. The health check is the
reliable answer.

</details>

<details>
<summary><b>Which session sends</b> — and why an unbound instance usually still works</summary>

Deliveries go out from the WhatsApp session bound to the ingress instance, and if the instance names
none, from the one session that is connected.

That fallback exists because the binding is close to unsettable from the dashboard: the field is free
text, stored verbatim with no lookup, and the Sessions page never shows the full id you would have to
paste. The usual result is an unbound instance, which looks healthy until every delivery dead-letters.

The rule is narrow on purpose — **it applies only when exactly one session is ready**, so there is no
wrong choice available:

- A binding to a ready session always wins. The fallback never overrides an explicit choice.
- A binding to a session that exists but is not ready fails, and says which and why.
- A binding to a session that no longer exists — deleted, or re-paired, which mints a new id — falls back
  and logs that it did.
- Two or more ready sessions with no binding fails and names them.

The health check reports which session will send, so an install that cannot deliver says so before a
notification is lost.

</details>

<details>
<summary><b>When a notification can be silently dropped</b></summary>

OpenWA de-duplicates ingress on `(pluginId, instanceId, providerDeliveryId)`. Seerr sends no delivery-id
header, so that id is a hash of the request body — **two notifications with byte-identical bodies
collide, and the second is answered `200 duplicate` before this plugin runs.** It stays dropped until the
row ages out (`INGRESS_DEDUP_RETENTION_DAYS`, default 7).

Most events are safe, because the default payload carries something that changes:

| Event | Distinguishing field | Safe? |
| --- | --- | --- |
| `MEDIA_*` | `request_id`, `requestedBy_*` | yes |
| `ISSUE_CREATED` | `issue_id` | yes |
| `ISSUE_COMMENT` | — | **no** |
| `ISSUE_RESOLVED` / `ISSUE_REOPENED` | `issue_id` + `issue_status` only | **no** |
| `TEST_NOTIFICATION` | — | **no** |

A declined request that is later re-requested is **not** a collision — Seerr issues a new `request_id`
and never reuses one. What does collide: the same person posting the same comment text twice, and an
issue resolved → reopened → resolved again.

Neither is fixable here or in Seerr's settings, because Seerr's template variables expose no comment id,
notification id or timestamp to vary on. Note the key includes `instanceId`, so recreating an instance
starts a fresh window.

</details>

## Upgrading

The banner's **Install it** button does this for you. By hand:

```bash
curl -X POST http://<openwa-host>:<port>/api/plugins/seerr-notify/update \
  -H "X-API-Key: <ADMIN_KEY>" -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/Alsharad/openwa-seerr-notify/releases/download/v<VERSION>/seerr-notify.zip#sha256=<SHA256>"}'
```

Use `/update`, not `/install` — uploading a newer zip is rejected with `already installed`, because the
dashboard's upload button creates rather than replaces. `/update` preserves your config, recipients and
enabled state.

The `#sha256=` fragment is an integrity pin, required by gateways running `PLUGIN_INSTALL_REQUIRE_PIN`.
Get it from GitHub's own asset digest:

```bash
gh release view v<VERSION> --repo Alsharad/openwa-seerr-notify \
  --json assets --jq '.assets[].digest | sub("^sha256:";"")'
```

## Good to know

- **Message length.** WhatsApp caps a caption at 1024 characters and a message at 4096. A long Now
  Available message sends the poster uncaptioned with the text following; text beyond 4096 splits on line
  boundaries.
- **Delivery is retried by the plugin**, not the host — twice, 1 s then 2 s. Failures land in a bounded
  dead-letter buffer (newest 50) that the health check reports.
- **The health badge only ever reflects the Seerr connection.** That is the one thing you cannot check by
  looking; an empty recipient list is reported in the message but never turns the badge red, because a
  badge that goes red for an unfinished setup teaches you to ignore it.
- **Per-session config is supported.** Config is re-read on every delivery, so dashboard edits apply
  without a restart.
- **A Seerr API failure costs enrichment, never delivery** — the message still goes out, just barer.

## More

- [SECURITY.md](./SECURITY.md) — what the plugin can do, what it exposes, and how to switch each off
- [CONTRIBUTING.md](./CONTRIBUTING.md) — build, layout, conventions
- [CHANGELOG.md](./CHANGELOG.md)

MIT
