// Seerr API enrichment, through the host's SSRF-guarded ctx.net.fetch.
//
// Every call here is BEST EFFORT. Enrichment adds detail (overview, ratings, cast, seasons) and resolves
// the requester's numeric Seerr id for a more reliable recipient match — but a Seerr that is down, slow
// or unreachable must degrade the notification, never drop it. So each fetch swallows its own failure
// and the caller carries on with whatever the webhook payload already contained.

import type { PluginNetResponse } from './types/openwa';
import type { MediaDetails, MediaRatings, NormalizedEvent } from './normalize.ts';

/** Below the host's 15 s net.fetch default, so a stalled Seerr cannot eat the whole enrichment budget. */
const FETCH_TIMEOUT_MS = 10_000;

export type NetFetch = (url: string, init?: { headers?: Record<string, string>; timeoutMs?: number }) => Promise<PluginNetResponse>;

export interface SeerrClientDeps {
  fetch: NetFetch;
  baseUrl: string;
  apiKey: string;
  log: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * GET a Seerr endpoint and JSON-parse it. Returns null on any failure — a non-2xx, a body that is not
 * JSON, a blocked host, or a Seerr error envelope (`{statusCode: 404, ...}`), which Seerr returns with a
 * 200 in some builds and would otherwise be formatted as if it were a media object.
 */
async function getJson<T>(deps: SeerrClientDeps, path: string): Promise<T | null> {
  const url = `${deps.baseUrl}${path}`;
  let res: PluginNetResponse;
  try {
    res = await deps.fetch(url, {
      headers: { 'X-Api-Key': deps.apiKey, Accept: 'application/json' },
      timeoutMs: FETCH_TIMEOUT_MS,
    });
  } catch (err) {
    // The most common cause here is the manifest net.allow / SSRF allowlist, so name it in the log.
    deps.log('seerr-notify: Seerr API request failed', {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!res.ok) {
    deps.log('seerr-notify: Seerr API returned an error status', { path, status: res.status });
    return null;
  }

  try {
    const parsed = JSON.parse(res.body) as T & { statusCode?: number };
    if (parsed && typeof parsed === 'object' && typeof parsed.statusCode === 'number') return null;
    return parsed;
  } catch {
    deps.log('seerr-notify: Seerr API returned a non-JSON body', { path, status: res.status });
    return null;
  }
}

export interface SeerrRequestDetails {
  requestedBy?: { id?: number | string; email?: string; username?: string; displayName?: string };
}

export function fetchRequestById(deps: SeerrClientDeps, requestId: string): Promise<SeerrRequestDetails | null> {
  return getJson<SeerrRequestDetails>(deps, `/api/v1/request/${encodeURIComponent(requestId)}`);
}

export interface SeerrUserRecord {
  id?: number | string;
  email?: string;
}

/**
 * Resolve a Seerr user by email. Seerr has no by-email lookup endpoint, so this pages the user list and
 * matches locally — the reason it is only used for ISSUE_* events, where no request id is available.
 */
export async function fetchUserByEmail(deps: SeerrClientDeps, email: string): Promise<SeerrUserRecord | null> {
  const data = await getJson<{ results?: SeerrUserRecord[] }>(deps, '/api/v1/user?take=100&skip=0');
  if (!data?.results) return null;
  const target = email.toLowerCase();
  return data.results.find((u) => typeof u.email === 'string' && u.email.toLowerCase() === target) ?? null;
}

export function fetchMediaDetails(deps: SeerrClientDeps, mediaType: string, tmdbId: string): Promise<MediaDetails | null> {
  const type = mediaType === 'movie' ? 'movie' : 'tv';
  return getJson<MediaDetails>(deps, `/api/v1/${type}/${encodeURIComponent(tmdbId)}`);
}

export function fetchMediaRatings(deps: SeerrClientDeps, mediaType: string, tmdbId: string): Promise<MediaRatings | null> {
  const path =
    mediaType === 'movie'
      ? `/api/v1/movie/${encodeURIComponent(tmdbId)}/ratingscombined`
      : `/api/v1/tv/${encodeURIComponent(tmdbId)}/ratings`;
  return getJson<MediaRatings>(deps, path);
}

/**
 * Enrich an event in place: resolve the actor's Seerr id so recipient matching can use it, and attach
 * media details (plus ratings, which only MEDIA_AVAILABLE renders).
 *
 * The two media fetches run concurrently; the actor lookup precedes them because it is what recipient
 * resolution depends on. Nothing here throws.
 */
export async function enrich(deps: SeerrClientDeps, event: NormalizedEvent): Promise<void> {
  const type = event.notificationType;

  if (type.startsWith('MEDIA_') && event.eventIds.requestId) {
    const details = await fetchRequestById(deps, event.eventIds.requestId);
    const requestedBy = details?.requestedBy;
    if (requestedBy) {
      event.requester = {
        email: String(requestedBy.email ?? event.requester.email).toLowerCase(),
        username: String(requestedBy.username ?? requestedBy.displayName ?? event.requester.username).toLowerCase(),
        userId: requestedBy.id !== undefined && requestedBy.id !== null ? String(requestedBy.id) : event.requester.userId,
      };
    }
  }

  if (type.startsWith('ISSUE_') && event.reporter.email) {
    const user = await fetchUserByEmail(deps, event.reporter.email);
    if (user?.id !== undefined && user.id !== null) {
      event.reporter = { ...event.reporter, userId: String(user.id) };
    }
  }

  if (type.startsWith('MEDIA_') && event.eventIds.mediaTmdbId) {
    const tmdbId = event.eventIds.mediaTmdbId;
    const wantRatings = type === 'MEDIA_AVAILABLE';
    const [details, ratings] = await Promise.all([
      fetchMediaDetails(deps, event.mediaType, tmdbId),
      wantRatings ? fetchMediaRatings(deps, event.mediaType, tmdbId) : Promise.resolve(null),
    ]);
    if (details) event.mediaDetails = details;
    if (ratings) event.mediaRatings = ratings;
  }
}
