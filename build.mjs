#!/usr/bin/env node
// Validate, bundle and package the plugin into an installable .zip.
//
// Adapted from the OpenWA-plugins monorepo packager so this repo stands alone. The gates it keeps are
// the ones that catch a broken release rather than a style slip:
//   • the manifest declares everything OpenWA needs, and `type` is installable
//   • the manifest version equals the top released CHANGELOG heading (one source of release truth)
//   • `main` is actually present in the archive — OpenWA refuses an archive whose main is missing, and
//     finding that out after tagging a release is the failure this prevents
//   • the archive stays under OpenWA's 5 MB install limit

import { build } from 'esbuild';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { zipStore } from './zip-store.mjs';

const ROOT = process.cwd();
const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

// ── Validate manifest ────────────────────────────────────────────────────────
if (!existsSync(join(ROOT, 'manifest.json'))) fail('no manifest.json');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

const missing = ['id', 'name', 'version', 'type', 'main'].filter((field) => !manifest[field]);
if (missing.length) fail(`manifest.json is missing: ${missing.join(', ')}`);
if (manifest.type !== 'extension') fail(`type must be "extension" to be installable (got "${manifest.type}")`);
// A JSON number here throws inside the host's ingress validation (it calls sdkVersion.split('.')).
if (manifest.sdkVersion !== undefined && typeof manifest.sdkVersion !== 'string') {
  fail('sdkVersion must be a STRING ("1"), not a number');
}

if (!existsSync(join(ROOT, 'CHANGELOG.md'))) fail('missing CHANGELOG.md');
const top = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').match(
  /^##\s*\[(\d+\.\d+\.\d+)\]\s*[—–-]\s*\d{4}-\d{2}-\d{2}/m,
);
if (!top) fail('CHANGELOG.md has no released "## [x.y.z] — YYYY-MM-DD" heading');
if (top[1] !== manifest.version) fail(`version drift: manifest ${manifest.version}, CHANGELOG ${top[1]}`);

// ── Build ────────────────────────────────────────────────────────────────────
await mkdir(join(ROOT, 'dist'), { recursive: true });
// Pins CommonJS so Node loads the bundle correctly even though this package is ESM.
await writeFile(join(ROOT, 'dist', 'package.json'), JSON.stringify({ type: 'commonjs' }));
await build({
  entryPoints: [join(ROOT, 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: join(ROOT, 'dist', 'index.js'),
  // The sandbox does not pass `manifest` into ctx, so the version is baked in at build time.
  define: { __PLUGIN_VERSION__: JSON.stringify(manifest.version) },
});

// ── Package ──────────────────────────────────────────────────────────────────
function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) collect(abs, out);
    else if (entry.isFile()) out.push({ name: relative(ROOT, abs).split('\\').join('/'), data: readFileSync(abs) });
  }
  return out;
}

const members = [
  { name: 'manifest.json', data: readFileSync(join(ROOT, 'manifest.json')) },
  { name: 'dist/index.js', data: readFileSync(join(ROOT, 'dist', 'index.js')) },
  { name: 'dist/package.json', data: readFileSync(join(ROOT, 'dist', 'package.json')) },
];

// A configUi plugin ships a static editor the host serves into a sandboxed iframe — include it.
if (manifest.configUi?.entry) {
  const entryDir = manifest.configUi.entry.split('/')[0];
  if (!existsSync(join(ROOT, manifest.configUi.entry))) fail(`configUi.entry "${manifest.configUi.entry}" not found`);
  if (statSync(join(ROOT, entryDir)).isDirectory()) members.push(...collect(join(ROOT, entryDir)));
}

const mainInZip = manifest.main.split('\\').join('/');
if (!members.some((file) => file.name === mainInZip)) {
  fail(`manifest main "${manifest.main}" is not in the package (members: ${members.map((f) => f.name).join(', ')})`);
}

const zip = zipStore(members);
const kb = (zip.length / 1024).toFixed(1);
if (zip.length > 5 * 1024 * 1024) fail(`package is ${kb} KB, over OpenWA's 5 MB install limit`);

const zipName = `${manifest.id}.zip`;
await rm(join(ROOT, zipName), { force: true });
await writeFile(join(ROOT, zipName), zip);

console.log(`✓ Packaged ${manifest.id} v${manifest.version} → ${zipName}  (${kb} KB)`);
console.log(`  sha256: ${createHash('sha256').update(zip).digest('hex')}`);
console.log(`  files:  ${members.map((f) => f.name).join(', ')}`);
