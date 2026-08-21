#!/usr/bin/env node
// Refresh the cached Seerr user roster into the plugin's config.
//
// WHY THIS IS A COMMAND AND NOT A BUTTON. The config editor runs in a `sandbox="allow-scripts"` srcdoc
// iframe with an opaque origin: it has no network of its own, and its only channel is postMessage to the
// dashboard, which handles exactly `config:get` and `config:save`. So the editor cannot call Seerr. A
// plugin cannot write its own config either — PluginContext exposes `config` as a read-only getter.
// The roster therefore has to be written by something holding an OpenWA admin key, which is this script.
// Deliberately manual: it runs when you run it, never on a timer.
//
// Usage:
//   SEERR_API_KEY=... node refresh-roster.mjs
//
// Environment:
//   SEERR_API_KEY   required — Seerr API key (the copy in plugin config reads back masked, so it
//                   cannot be reused from there)
//   OPENWA_URL      default http://localhost:2785
//   OPENWA_API_KEY  default: read from OPENWA_API_KEY_FILE
//   OPENWA_API_KEY_FILE  default /app/data/.api-key (host path outside Docker, e.g. <appdata>/openwa/.api-key)
//   SEERR_URL       default: taken from the plugin's own jellyseerrUrl config
//   PLUGIN_ID       default seerr-notify
//   DRY_RUN=1       fetch and print the roster, write nothing

import { readFileSync } from 'node:fs';

const OPENWA_URL = (process.env.OPENWA_URL ?? 'http://localhost:2785').replace(/\/+$/, '');
const PLUGIN_ID = process.env.PLUGIN_ID ?? 'seerr-notify';
const KEY_FILE = process.env.OPENWA_API_KEY_FILE ?? '/app/data/.api-key';
const DRY_RUN = process.env.DRY_RUN === '1';

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function openwaKey() {
  if (process.env.OPENWA_API_KEY) return process.env.OPENWA_API_KEY.trim();
  try {
    return readFileSync(KEY_FILE, 'utf8').trim();
  } catch {
    die(`no OpenWA API key: set OPENWA_API_KEY or make ${KEY_FILE} readable`);
  }
}

async function api(path, init = {}) {
  const res = await fetch(`${OPENWA_URL}${path}`, {
    ...init,
    headers: { 'X-API-Key': openwaKey(), 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) die(`OpenWA ${init.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** Seerr's Permission.ADMIN bit. Kept in lockstep with roster.ts by roster.test.ts. */
const SEERR_ADMIN_PERMISSION = 2;

/** Page through /api/v1/user — a large Seerr install will not fit one page. */
async function fetchSeerrUsers(baseUrl, apiKey) {
  const pageSize = 100;
  const users = [];
  for (let skip = 0; ; skip += pageSize) {
    const res = await fetch(`${baseUrl}/api/v1/user?take=${pageSize}&skip=${skip}`, {
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) die(`Seerr GET /api/v1/user → ${res.status}. Check SEERR_URL and SEERR_API_KEY.`);
    const body = await res.json();
    const page = Array.isArray(body?.results) ? body.results : [];
    users.push(...page);
    const total = body?.pageInfo?.results;
    if (page.length < pageSize || (typeof total === 'number' && users.length >= total)) break;
  }
  return users;
}

const seerrApiKey = (process.env.SEERR_API_KEY ?? '').trim();
if (!seerrApiKey) die('SEERR_API_KEY is required (the key in plugin config reads back masked)');

const plugin = await api(`/api/plugins/${PLUGIN_ID}`);
const config = plugin.config ?? {};
const seerrUrl = (process.env.SEERR_URL ?? config.jellyseerrUrl ?? '').replace(/\/+$/, '');
if (!seerrUrl) die('no Seerr URL: set SEERR_URL, or configure jellyseerrUrl on the plugin first');

const records = await fetchSeerrUsers(seerrUrl, seerrApiKey);
const roster = records
  .map((record) => {
    const id = Number(record?.id);
    if (!Number.isFinite(id)) return null;
    const name = String(record?.displayName ?? record?.username ?? '').trim();
    return {
      id,
      name,
      email: String(record?.email ?? '').trim().toLowerCase(),
      isAdmin: (Number(record?.permissions) & SEERR_ADMIN_PERMISSION) !== 0,
    };
  })
  .filter(Boolean)
  .sort((a, b) => a.id - b.id);

const admins = roster.filter((entry) => entry.isAdmin);
console.log(`Seerr ${seerrUrl}: ${roster.length} user(s), ${admins.length} admin(s)`);
for (const entry of roster) {
  console.log(`  ${String(entry.id).padStart(4)}  ${entry.isAdmin ? 'ADMIN' : '     '}  ${entry.name}`);
}

if (DRY_RUN) {
  console.log('DRY_RUN=1 — config not written');
  process.exit(0);
}

// The stored Seerr API key reads back as '***'; writing it back unchanged is how the host is told to
// keep the value it already has, so this round-trip does not clobber the secret.
const merged = { ...config, seerrRoster: roster, rosterSyncedAt: new Date().toISOString() };
await api(`/api/plugins/${PLUGIN_ID}/config`, { method: 'PUT', body: JSON.stringify({ config: merged }) });

const enabled = Array.isArray(config.users) ? config.users.filter((u) => u?.enabled !== false && u?.number).length : 0;
console.log(`✓ Roster written to ${PLUGIN_ID} config. ${enabled} recipient(s) currently enabled.`);
console.log('  Open Configure > Recipients to tick users and set their numbers.');
