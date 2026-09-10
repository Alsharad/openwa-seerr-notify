// The directory layout is only worth having if it stays true, and nothing else here would notice it
// drifting: an import that reaches sideways still compiles, still passes every other test, and is only
// visible to someone who goes looking. So the allowed direction is written down and asserted.
//
// Tests are exempt. A test may reach for whatever it needs to set a case up — config-ui.test.ts spans
// four folders on purpose — and constraining that buys nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { ROOT } from './test-support.ts';

const SRC = join(ROOT, 'src');

/**
 * What each folder is allowed to import from, itself included. The order is the dependency order:
 * `host` at the bottom importing nothing, `index.ts` at the top reaching anything.
 */
const ALLOWED: Record<string, string[]> = {
  // Host type declarations. A .d.ts is scanned like any other .ts, and this one must stay a leaf.
  types: [],
  host: ['host'],
  settings: ['settings'],
  seerr: ['seerr', 'types'],
  notify: ['notify', 'settings', 'seerr', 'host', 'types'],
  panel: ['panel', 'notify', 'settings', 'seerr', 'host', 'types'],
  // index.ts and its neighbours at the root of src/ compose everything below them.
  '.': ['.', 'panel', 'notify', 'settings', 'seerr', 'host', 'types'],
};

/** The folder a path sits in, relative to src/ — '.' for src/index.ts itself. */
function folderOf(absolute: string): string {
  const rel = relative(SRC, dirname(absolute));
  return rel === '' ? '.' : rel.split(/[\\/]/)[0];
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && entry.name !== 'test-support.ts') {
      out.push(path);
    }
  }
  return out;
}

test('every folder imports only in the allowed direction', () => {
  const violations: string[] = [];

  for (const file of sourceFiles(SRC)) {
    const from = folderOf(file);
    const allowed = ALLOWED[from];
    assert.ok(allowed, `${relative(SRC, file)} sits in an undeclared folder "${from}"`);

    for (const [, spec] of readFileSync(file, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
      const to = folderOf(resolve(dirname(file), spec));
      if (!allowed.includes(to)) {
        violations.push(`${relative(SRC, file)} imports ${spec} — ${from} may not reach ${to}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test('the layout the README draws is the layout on disk', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const onDisk = readdirSync(SRC, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(onDisk, Object.keys(ALLOWED).filter((name) => name !== '.').sort());
  for (const folder of onDisk) {
    assert.match(readme, new RegExp(`^\\s*${folder}/`, 'm'), `the README layout omits src/${folder}`);
  }
});
