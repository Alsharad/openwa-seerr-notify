# Contributing

The [README](./README.md) is for people running the plugin. This is for people changing it.

## Build and test

```bash
npm ci
npm run check      # typecheck → tests → package. The only gate.
```

Node 22+. Tests are `node --test` with `tsx` — no framework, no config.

`npm run build` writes `seerr-notify.zip`. Packaging is a gate, not just a bundler: it refuses to build
when `manifest.json`, `package.json` and the top released `CHANGELOG.md` heading disagree on the version,
when `manifest.main` is missing from the archive, or when the result exceeds OpenWA's 5 MB install limit.

There is no CI. Actions on this repository are billing-locked, so `.github/workflows/ci.yml` is
**disabled** — it produced a failed run per push without executing a single step. Its header explains
the two things to fix before re-enabling it. `npm run check` passing locally is the gate.

## Layout

```
src/
  index.ts        the plugin object the host loads: lifecycle, ingress, health
  settings/       operator config — parsing, defaults, validation
                    config.ts  content.ts  routing.ts  roster.ts
  seerr/          talking to Seerr, and reading what it sends
                    seerr-client.ts  normalize.ts  probe.ts
  notify/         turning an event into messages and delivering them
                    handler.ts  formatter.ts  recipients.ts
                    deliver.ts  deadletter.ts
  panel/          what the settings panel's buttons trigger
                    setup.ts  update-check.ts  test-send.ts  roster-refresh.ts
  host/           the OpenWA gateway itself
                    gateway.ts  session-resolve.ts
  types/          host type declarations
scripts/          build.mjs  zip-store.mjs  refresh-roster.mjs  send-test.mjs
config/index.html the settings panel, shipped as-is inside the zip
```

Tests sit beside what they test — `src/notify/formatter.test.ts` covers `src/notify/formatter.ts`.

Dependencies run one way, with no cycles: `index.ts` → `panel/` → `notify/` → `settings/` + `seerr/`.
`settings/` imports nothing outside itself, `seerr/` reaches only the host type declarations, and `host/`
sits at the bottom importing nothing at all. `src/layout.test.ts` asserts that direction, and asserts
that the diagram above still matches the directories on disk — so neither can quietly drift.

`config/index.html` stays at the repository root on purpose: `build.mjs` packages it by its top-level
directory name, so moving it under `src/` would mean a special case in the build for no gain.

## Conventions

**The panel is one component vocabulary.** `.card`, `.card-head`, `.rail`, `.switch`, `.pill` — a
component is designed once and used on every tab. Two tabs doing the same thing two different ways reads
as broken. Before shipping a UI change, audit *every* tab for the component and behaviour being changed,
not just the one that prompted it, and fix the root rule rather than patching the instance.

**Panel copy is terse.** A label labels; at most one short line under it where the label cannot carry the
meaning. No byte limits, buffer names or internals on screen — the README's Configuration section is
where detail belongs.

**Assert UI invariants as tests.** Nothing in this toolchain renders `config/index.html`: esbuild bundles
`src/index.ts`, and the panel ships as-is. Every UI bug so far was caught by a screenshot, not by a
compiler. `src/panel/config-ui.test.ts` parses the HTML and asserts what silently regresses — the
editor's default tables matching the code they mirror, every `el('id')` resolving, the script parsing,
the tab order, accessibility rules, and that no switch is decorative.

**Mutation-test every guard you add.** Break the thing on purpose and confirm the test fails. A guard
that cannot fail is worse than none.

**Bump the version on every change that ships.** `manifest.json`, `package.json` and the `CHANGELOG.md`
heading together, or the build refuses to package. Shipping several changes under one version number
makes "which build am I running" unanswerable from the plugin row. A docs-only change that leaves the
packaged artifact untouched does not need one.

## Releasing

By hand.

```bash
npm run check
git commit && git push
gh release create v<x.y.z> seerr-notify.zip --title "v<x.y.z>" --notes "…"
```

Attach the **zip alone**. The `.sha256` sidecar releases carried before v1.18.0 is dead weight: the
in-panel updater pins its download to `assets[].digest`, the hash GitHub computes for the asset, and it
could not read a sidecar anyway because `ctx.net.fetch` refuses the 302 an asset URL answers with.

Do **not** use `POST /api/plugins/install` to upgrade a live gateway — it is create-only and answers 409
`already installed`. `POST /plugins/:id/update` replaces in place and preserves config and enabled state.

## Host constraints worth knowing

Verified against the OpenWA gateway source and a live gateway. None are obvious, and each cost real
debugging time.

**The config UI is a sandboxed iframe with no network.** `sandbox="allow-scripts"`, opaque origin, an
injected CSP with `connect-src 'none'`. Its only channel is `config:get` / `config:save`. No `fetch`, no
`confirm()`, no `target="_blank"`. Anything the panel needs fetched, the plugin must fetch and write into
config for the panel to read.

**A plugin cannot write its own config through the supported surface.** `PluginContext.config` is a
read-only getter; the only writer is `PUT /api/plugins/:id/config`, which needs an ADMIN unscoped key. So
the plugin reads the gateway's own key from `/app/data/.api-key` and self-calls over loopback with Node's
global `fetch` — `ctx.net.fetch` is SSRF-guarded and blocks loopback. `src/host/gateway.ts` is the whole
of it, and the README's Security section documents the trade.

**Config writes shallow-merge**, so a partial patch never clobbers other keys. That is what makes a
background write safe while the operator has the editor open — and why the panel's re-read trick sends an
*empty* patch rather than the whole form.

**Secrets are redacted before the panel sees them.** A schema field with `secret: true` arrives as `***`,
and sending it back means "keep the stored value". A panel can only display a credential the plugin has
mirrored into an unredacted field.

**`ctx.net.fetch` refuses redirects**, so a GitHub release asset URL (302) cannot be read through it. The
gateway's own plugin-download path does follow redirects, which is why installing from a release URL
works while fetching a sidecar from one does not.

**`net.allowConfigHosts` only admits https URLs**, which is why `net.allow` is `["*"]` here. With a fixed
host list every self-hosted-Seerr install fails with `Plugin seerr-notify may not fetch …`, and the only
fix would be unzipping the package to edit the manifest. The real gate is the host's SSRF guard plus
`SSRF_ALLOWED_HOSTS`, which the operator can reach.

**An `onEnable` that throws marks the plugin ERROR, and the host does not deliver config changes to a
plugin in ERROR** — which strands any panel button that works by saving a config change.

## Why delivery is backgrounded

The host dispatches an ingress handler with a **5 second** budget and does **not** cancel the work when
that expires — it records the delivery as failed while the handler keeps running. This notification does
up to three Seerr API calls and then one poster upload per recipient, and the host budgets a *single*
media send at 120 s. Awaiting that inside the handler would produce a false dispatch failure, and a
redrive of it would re-run a handler that had already sent — delivering the notification twice.

The trade is explicit: the host's ingress retry and dead-letter machinery no longer covers delivery,
because the handler has already returned successfully by the time a send can fail. Retries and dead
letters are the plugin's own — `src/notify/deliver.ts` and `src/notify/deadletter.ts`.

## Test rigs

Neither is needed to run the plugin; both need a source checkout. For ordinary testing, the panel's
**Setup → Send a test message** button is the rig, and needs none of this.

```bash
# Send real events through the live ingress route. Each run carries a _nonce, so it is never
# deduplicated — unlike Seerr's own Test button, which works exactly once.
export SEERR_INGRESS_TOKEN=<instance secret>
export INGRESS_URL=http://<openwa-host>:<port>/api/ingress/seerr-notify/seerr-prod/seerr

node scripts/send-test.mjs --list                        # every event type
node scripts/send-test.mjs MEDIA_AVAILABLE --as alice    # poster + enrichment, to a requester
```

`--as` is the Seerr username or email the event comes from. It must match a mapped, enabled recipient,
since every event except `TEST_NOTIFICATION` routes to its requester or reporter by default.

```bash
# Refresh the cached Seerr roster without the panel button, taking the admin key from the
# environment rather than /app/data/.api-key.
SEERR_API_KEY=... node scripts/refresh-roster.mjs
```
