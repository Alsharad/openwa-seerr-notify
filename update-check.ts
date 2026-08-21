// "There is a newer release on GitHub" — checked by the plugin, rendered by the editor.
//
// The editor cannot do this itself: its document carries `connect-src 'none'` and its origin is opaque,
// so it has no fetch at all. The plugin has one (ctx.net.fetch, SSRF-guarded and pinned to the manifest
// net.allow list, which is why api.github.com is declared there), and the result is parked in config for
// the editor to read on its next handshake.
//
// Nothing here downloads or installs anything. It compares two version strings and produces a link.

import type { NetFetch } from './seerr-client.ts';

/** A release check must never delay a config save for long; GitHub is either quick or not answering. */
const TIMEOUT_MS = 8000;
/** GitHub allows 60 unauthenticated requests per hour per IP. One a day leaves that entirely alone. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateState {
  /** The running plugin version, baked in at build time. */
  current: string;
  /** Latest release tag, normalized without the leading "v". Empty when the check could not answer. */
  latest: string;
  /** Where to go: the release page when there is one, else the repository's releases index. */
  url: string;
  /** ISO timestamp of this check — also the throttle marker. */
  checkedAt: string;
  available: boolean;
  /** Human-readable outcome when there is nothing to offer (no releases yet, rate-limited, offline). */
  note: string;
}

/** "https://github.com/owner/repo" (or a .git / trailing-slash variant) → "owner/repo". */
export function repoSlug(repository: string): string {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(repository ?? '').trim());
  return match ? `${match[1]}/${match[2]}` : '';
}

/** Numeric release components, ignoring a leading "v" and any pre-release/build suffix. */
function numbers(version: string): number[] {
  const core = /^\d+(?:\.\d+)*/.exec(String(version ?? '').trim().replace(/^v/i, ''));
  return core ? core[0].split('.').map(Number) : [];
}

function prerelease(version: string): string {
  const match = /^\d+(?:\.\d+)*[-+](.+)$/.exec(String(version ?? '').trim().replace(/^v/i, ''));
  return match ? match[1] : '';
}

/**
 * Is `latest` a release the operator does not have?
 *
 * Deliberately conservative: an unparseable version, or one that only differs by a pre-release suffix
 * the running build already carries, answers false. A banner that cries wolf gets ignored, and this one
 * has no way for the operator to say "yes I know".
 */
export function isNewer(latest: string, current: string): boolean {
  const a = numbers(latest);
  const b = numbers(current);
  if (a.length === 0 || b.length === 0) return false;

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  // Same numbers: a final release supersedes the pre-release of the same version (1.6.0 > 1.6.0-rc.1),
  // and nothing supersedes a final release.
  return prerelease(latest) === '' && prerelease(current) !== '';
}

/**
 * Ask GitHub for the newest release of `slug`. Total: never throws, and every failure mode reports
 * itself in `note` rather than as an error, because a release check failing is not a plugin fault and
 * must not colour the plugin's health.
 */
export async function checkForUpdate(
  fetchFn: NetFetch,
  slug: string,
  current: string,
  now: () => Date = () => new Date(),
): Promise<UpdateState> {
  const base: UpdateState = {
    current,
    latest: '',
    url: slug ? `https://github.com/${slug}/releases` : '',
    checkedAt: now().toISOString(),
    available: false,
    note: '',
  };
  if (!slug) return { ...base, note: 'no GitHub repository is declared in the manifest' };

  let res;
  try {
    res = await fetchFn(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openwa-seerr-notify' },
      timeoutMs: TIMEOUT_MS,
    });
  } catch (err) {
    return { ...base, note: `could not reach GitHub: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 404 is the normal answer for a repository whose releases page is empty — it is not an error, and
  // saying so beats reporting "HTTP 404" to someone who has done nothing wrong.
  if (res.status === 404) return { ...base, note: 'no releases have been published yet' };
  if (res.status === 403 || res.status === 429) return { ...base, note: 'GitHub rate-limited the check; it will retry later' };
  if (!res.ok) return { ...base, note: `GitHub answered HTTP ${res.status}` };

  // /releases/latest is GitHub's "newest non-draft, non-pre-release", so no filtering is needed here.
  let release: { tag_name?: unknown; html_url?: unknown };
  try {
    release = JSON.parse(res.body) as typeof release;
  } catch {
    return { ...base, note: 'GitHub returned a response this could not read' };
  }

  const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
  if (!tag) return { ...base, note: 'the newest release carries no tag' };

  const latest = tag.replace(/^v/i, '');
  const url = typeof release.html_url === 'string' && release.html_url ? release.html_url : base.url;
  const available = isNewer(latest, current);
  return {
    ...base,
    latest,
    url,
    available,
    note: available ? '' : 'up to date',
  };
}
