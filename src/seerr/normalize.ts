// Seerr webhook payload → the normalized shape the formatter and recipient resolver consume.

/** Built through the RegExp constructor so this source file carries no literal control bytes. */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');

export function sanitizeText(input: unknown, maxLen = 1200): string {
  if (typeof input !== 'string') return '';
  return input.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

export interface SeerrActor {
  email: string;
  username: string;
  userId: string | null;
}

/** The subset of a Seerr `/movie/:id` or `/tv/:id` response the formatter reads. */
export interface MediaDetails {
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  overview?: string;
  voteAverage?: number;
  runtime?: number;
  episodeRunTime?: number[];
  genres?: Array<{ name?: string }>;
  credits?: { cast?: Array<{ name?: string; character?: string }>; crew?: Array<{ name?: string; job?: string }> };
  createdBy?: Array<{ name?: string }>;
  relatedVideos?: Array<{ type?: string; site?: string; url?: string }>;
  seasons?: Array<{ seasonNumber?: number }>;
  mediaInfo?: { seasons?: Array<{ seasonNumber?: number; status?: number }> };
  collection?: { name?: string };
}

/** The subset of a Seerr ratings response the formatter reads. */
export interface MediaRatings {
  imdb?: { criticsScore?: number | null };
  rt?: { criticsScore?: number | null };
  criticsScore?: number | null;
}

export interface NormalizedEvent {
  notificationType: string;
  eventName: string;
  subject: string;
  message: string;
  posterUrl: string;
  mediaType: string;
  requester: SeerrActor;
  reporter: SeerrActor;
  commenter: SeerrActor;
  commentMessage: string;
  issueType: string | null;
  requestedSeasons: string | null;
  resolverUsername: string | null;
  eventIds: {
    requestId: string | null;
    issueId: string | null;
    mediaTmdbId: string | null;
    mediaTvdbId: string | null;
  };
  /** Filled in by the enrichment step when the Seerr API is reachable. */
  mediaDetails?: MediaDetails;
  mediaRatings?: MediaRatings;
}

type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);
const sub = (payload: Dict, key: string): Dict => (isDict(payload[key]) ? (payload[key] as Dict) : {});

/**
 * Assert the payload is usable. Seerr's webhook body is operator-templated, so almost every field is
 * genuinely optional — only `notification_type` decides how the event is routed and formatted, and an
 * event without it cannot be handled at all.
 */
export function validatePayload(payload: unknown): { ok: true; value: Dict } | { ok: false; reason: string } {
  if (!isDict(payload)) return { ok: false, reason: 'payload is not a JSON object' };
  if (typeof payload.notification_type !== 'string' || payload.notification_type.trim() === '') {
    return { ok: false, reason: 'notification_type is missing or not a non-empty string' };
  }
  return { ok: true, value: payload };
}

function normalizeActor(email: unknown, username: unknown, userId: unknown = null): SeerrActor {
  return {
    email: sanitizeText(email).toLowerCase(),
    username: sanitizeText(username).toLowerCase(),
    userId: userId === undefined || userId === null || userId === '' ? null : String(userId),
  };
}

function normalizeId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return sanitizeText(String(value), 120) || null;
}

function getRequestedSeasons(payload: Dict): string | null {
  const extra = Array.isArray(payload.extra) ? payload.extra : [];
  const match = extra.find((e) => isDict(e) && String(e.name ?? '').toLowerCase() === 'requested seasons');
  const value = isDict(match) ? match.value : undefined;
  return value ? sanitizeText(String(value), 240) : null;
}

export function normalizePayload(payload: Dict): NormalizedEvent {
  const media = sub(payload, 'media');
  const request = sub(payload, 'request');
  const issue = sub(payload, 'issue');
  const comment = sub(payload, 'comment');

  return {
    notificationType: sanitizeText(payload.notification_type).toUpperCase(),
    eventName: sanitizeText(payload.event),
    subject: sanitizeText(payload.subject, 240) || 'Unknown Title',
    message: sanitizeText(payload.message, 2000),
    posterUrl: sanitizeText(payload.image, 2048),
    mediaType: (sanitizeText(media.media_type) || 'unknown').toLowerCase(),
    requester: normalizeActor(request.requestedBy_email, request.requestedBy_username),
    reporter: normalizeActor(issue.reportedBy_email, issue.reportedBy_username),
    commenter: normalizeActor(comment.commentedBy_email, comment.commentedBy_username),
    commentMessage: sanitizeText(comment.comment_message, 1200),
    issueType: sanitizeText(issue.issue_type, 64) || null,
    requestedSeasons: getRequestedSeasons(payload),
    resolverUsername: sanitizeText(issue.resolvedBy_username).toLowerCase() || null,
    eventIds: {
      requestId: normalizeId(request.request_id),
      issueId: normalizeId(issue.issue_id),
      mediaTmdbId: normalizeId(media.tmdbId),
      mediaTvdbId: normalizeId(media.tvdbId),
    },
  };
}
