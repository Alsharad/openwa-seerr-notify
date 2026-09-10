// Repo paths for the tests that assert against files rather than behaviour — the config editor's HTML,
// the manifest, the standalone scripts.
//
// Kept in one place because those paths are the one thing a directory move silently breaks: an import
// that no longer resolves fails loudly, while `join(HERE, '..', 'thing')` just reads the wrong file.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root. This file lives at `src/`, so the root is one level up. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A path from the repository root, e.g. `repoFile('config', 'index.html')`. */
export const repoFile = (...parts: string[]): string => join(ROOT, ...parts);
