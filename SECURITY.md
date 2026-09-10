# Security

What this plugin can do, what it exposes, and where you can switch each of those off. Nothing here is a
disclosure process — for a vulnerability in the plugin itself, open an issue on the repository.

## The delivery path

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
  Connection tab can display it — see [The Seerr API key is readable in `setup`](#the-seerr-api-key-is-readable-in-setup) for why,
  what it costs, and the one function to delete if you disagree. It is never logged. The ingress secret is not stored by
  this plugin at all.
- **Secrets in logs**: chat ids are masked to their last four digits, and message bodies are never
  logged, at any log level.
- **The worker is crash containment, not a security boundary** — as OpenWA's own docs state. Plugin code
  keeps `require('fs')` and raw sockets whatever the manifest declares.
- **`net.allow` is `["*"]`**, because the host only auto-admits an `https` config URL and a self-hosted
  Seerr is almost never https — see *Reaching a self-hosted Seerr* under [Troubleshooting](./README.md#troubleshooting). The plugin fetches exactly two kinds
  of host: the Seerr URL you configured, and `api.github.com` for the release check (which you can switch
  off). The SSRF guard still refuses private addresses unless `SSRF_ALLOWED_HOSTS` says otherwise.
- **⚠️ The plugin can replace itself.** The Install button calls `POST /plugins/seerr-notify/update`
  with the gateway's own admin key, which unloads the running plugin and installs a new package. The
  chain that makes that acceptable: the download URL comes from the GitHub release feed of the repository
  baked into the manifest **at build time** — never from config, so no config write can redirect it — and
  it is pinned to the sha256 GitHub publishes for the asset itself (`assets[].digest`), so the hash is
  neither computed from the downloaded bytes nor transcribed by hand. A release whose asset carries no
  digest is refused. If you would rather this did not exist, delete `installUpdate` from `src/panel/setup.ts`; the check
  and the banner keep working, and `Options → Check GitHub` switches off the check entirely.
- **⚠️ The Refresh button and the Setup tab step outside the plugin capability model.** Nothing in the
  supported surface lets a plugin write its own config: the editor is an opaque-origin sandbox with no
  network whose only channel speaks `config:get` / `config:save`, and `PluginContext.config` is a
  read-only getter. The only writer is `PUT /api/plugins/:id/config`, which requires an ADMIN, unscoped
  key. So the plugin reads the gateway's own key from `/app/data/.api-key` and calls that endpoint —
  `src/host/gateway.ts` is the whole of it. Specifically:
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

  If you would rather no plugin on your host could do this, delete `src/host/gateway.ts`,
  `src/panel/setup.ts`, `src/panel/roster-refresh.ts` and the `onConfigChange` handler in
  `src/index.ts`, and use `scripts/refresh-roster.mjs`, which takes the key from the environment of
  whoever runs it. You lose the Setup tab and the update banner;
  everything on the delivery path works unchanged.

## The Seerr API key is readable in `setup`

`setup.seerrApiKey` mirrors your Seerr API key so the Connection tab can show it. A field flagged
`secret` in the schema reaches the config screen as `***`, so a panel can only ever display a credential
the plugin puts somewhere unredacted — without the mirror that field showed three asterisks, and then an
empty box.

What it costs: an ADMIN, unscoped API key reading `GET /plugins` sees the value in the clear. Everything
that can read it could already do more than read it — that key class can rewrite the config or uninstall
the plugin — and Seerr stores its own copy in the clear regardless. If you would rather it did not,
delete `mirrorSeerrKey` from `src/index.ts`; the field falls back to an empty box that still saves correctly.

The **ingress secret is not stored here at all** — OpenWA's Instances tab owns it.
