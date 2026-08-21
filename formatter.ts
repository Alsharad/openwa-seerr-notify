// Message text for each Seerr event type. Pure: no I/O, no host calls, so every branch is unit-testable.
//
// Two messages are produced per event. Recipients flagged admin get the second one, which appends an
// "Admin Info" block with the requester/reporter identity and the Seerr ids needed to act on the event.

import type { MediaAvailableFlags } from './config.ts';
import type { MediaDetails, NormalizedEvent } from './normalize.ts';
import { supportsAdminInfo } from './routing.ts';

// Which events the Admin Info block is even expressible for is decided by supportsAdminInfo(); whether
// it is actually appended is the operator's per-event `adminInfo` toggle.

/** Season status codes as Seerr reports them in `mediaInfo.seasons[].status`. */
const SEASON_STATUS_LABEL: Record<number, string> = {
  2: '⏳ Pending',
  3: '⚙️  Processing',
  4: '⬇️ Partially Available',
  5: '✅ Available',
  6: '📥 Can Request (was deleted)',
};

function getMediaEmoji(mediaType: string): string {
  return mediaType === 'movie' ? '🎬' : '📺';
}

function getIssueTypeEmoji(issueType: string | null): string {
  if (!issueType) return '🐛';
  switch (issueType.toUpperCase()) {
    case 'VIDEO':
      return '📹';
    case 'AUDIO':
      return '🔊';
    case 'SUBTITLES':
      return '💬';
    case 'OTHER':
      return '❓';
    default:
      return '🐛';
  }
}

function formatIssueType(issueType: string | null): string | null {
  if (!issueType) return null;
  return issueType.charAt(0).toUpperCase() + issueType.slice(1).toLowerCase();
}

export function getGenreNames(details: MediaDetails | undefined): string[] {
  return (details?.genres ?? []).map((g) => g.name).filter((n): n is string => Boolean(n));
}

/** Requester lines shared by MEDIA_PENDING / APPROVED / DECLINED / FAILED admin messages. */
function buildRequesterLines(event: NormalizedEvent): string[] {
  const lines = [`👤 Requested by: ${event.requester.username || 'Unknown User'}`];
  if (event.requester.userId) lines.push(`🪪 User ID: ${event.requester.userId}`);
  if (event.eventIds.requestId) lines.push(`🆔 Request ID: ${event.eventIds.requestId}`);
  return lines;
}

/** Issue lines shared by every ISSUE_* admin message. */
function buildIssueAdminLines(issueId: string | null, issueType: string | null): string[] {
  const lines: string[] = [];
  if (issueId) lines.push(`🆔 Issue ID: ${issueId}`);
  if (issueType) lines.push(`📋 Issue Type: ${formatIssueType(issueType)}`);
  return lines;
}

function formatMediaAvailable(event: NormalizedEvent, f: MediaAvailableFlags): string {
  const details = event.mediaDetails;
  const movie = event.mediaType === 'movie';

  // No enrichment (API off, unreachable, or the item was not found) — fall back to the bare headline
  // rather than emitting a message full of empty sections.
  if (!details) {
    return `✅ Now Available\n\n${getMediaEmoji(event.mediaType)} ${event.subject}`;
  }

  const title = details.title || details.name || event.subject;
  const rawDate = (details.releaseDate || details.firstAirDate || '').split('T')[0];
  const lines: string[] = ['✅ Now Available', `*${title}*`];

  if (f.showReleaseDate && rawDate) lines.push(`📅 ${rawDate}`);

  if (f.showRatings) {
    const ratings = event.mediaRatings;
    let bestRating: string | null = null;
    if (ratings) {
      if (ratings.imdb?.criticsScore != null) bestRating = `${ratings.imdb.criticsScore}/10`;
      else if (ratings.rt?.criticsScore != null) bestRating = `${ratings.rt.criticsScore}%`;
      else if (ratings.criticsScore != null) bestRating = `${ratings.criticsScore}%`;
    }
    if (!bestRating && (details.voteAverage ?? 0) > 0) bestRating = `${details.voteAverage}/10`;
    const runtime = details.runtime || (Array.isArray(details.episodeRunTime) ? details.episodeRunTime[0] : null);
    const metaParts: string[] = [];
    if (bestRating) metaParts.push(`⭐ ${bestRating}`);
    if (runtime) metaParts.push(`⏱ ${runtime} min`);
    if (metaParts.length) lines.push(metaParts.join('  |  '));
  }

  if (f.showOverview && details.overview) {
    lines.push('', `_${details.overview}_`);
  }

  if (f.showGenres) {
    const genres = getGenreNames(details);
    if (genres.length) lines.push('', `🎭 ${genres.join(', ')}`);
  }

  if (f.showDirector) {
    const directors = (details.credits?.crew ?? []).filter((c) => c.job === 'Director').map((c) => c.name);
    const creators = (details.createdBy ?? []).map((c) => c.name);
    if (directors.length) lines.push('', `🎬 ${directors.join(', ')}`);
    else if (creators.length) lines.push('', `✍️ ${creators.join(', ')}`);
  }

  if (f.showCast) {
    const cast = (details.credits?.cast ?? []).slice(0, 5).filter((c) => c.name);
    if (cast.length) {
      lines.push('', '👥 *Cast*');
      for (const c of cast) lines.push(`* ${c.name} as ${c.character}`);
    }
  }

  if (f.showTrailer) {
    const trailer = (details.relatedVideos ?? []).find((v) => v.type === 'Trailer' && v.site === 'YouTube');
    if (trailer?.url) lines.push('', `🎥 ${trailer.url}`);
  }

  if (!movie && f.showSeasons) {
    const trackedStatuses = new Map<number, number>();
    for (const s of details.mediaInfo?.seasons ?? []) {
      if (typeof s.seasonNumber === 'number' && typeof s.status === 'number') {
        trackedStatuses.set(s.seasonNumber, s.status);
      }
    }
    // Season 0 is the specials bucket; Seerr shows it separately and it is noise in a notification.
    const seasons = (details.seasons ?? [])
      .filter((s): s is { seasonNumber: number } => typeof s.seasonNumber === 'number' && s.seasonNumber > 0)
      .sort((a, b) => a.seasonNumber - b.seasonNumber);
    if (seasons.length) {
      lines.push('', '📺 *Seasons*');
      for (const s of seasons) {
        const status = trackedStatuses.get(s.seasonNumber) ?? 1;
        lines.push(`* Season ${s.seasonNumber} — ${SEASON_STATUS_LABEL[status] ?? '📥 Can Request'}`);
      }
    }
  }

  if (movie && f.showCollection && details.collection?.name) {
    lines.push('', `🎬 Part of: *${details.collection.name}*`);
  }

  return lines.join('\n');
}

function addIssueDetails(msg: string, event: NormalizedEvent): string {
  let out = msg;
  if (event.issueType) {
    out += `${getIssueTypeEmoji(event.issueType)} Issue Type: ${formatIssueType(event.issueType)}\n`;
  }
  if (event.message) out += `📝 Message: ${event.message}\n`;
  return out;
}

export function formatUserMessage(event: NormalizedEvent, f: MediaAvailableFlags): string {
  const { subject, eventName: name } = event;
  const emoji = getMediaEmoji(event.mediaType);
  const movie = event.mediaType === 'movie';

  switch (event.notificationType) {
    case 'MEDIA_PENDING': {
      const details = event.mediaDetails;
      const lines = [`⏳ Request Submitted\n\n${emoji} ${subject}`];
      if (!movie && event.requestedSeasons) lines.push(`${emoji} Seasons: ${event.requestedSeasons}`);
      if (details?.overview) lines.push('', `_${details.overview}_`);
      const genres = getGenreNames(details);
      if (genres.length) lines.push('', `🎭 ${genres.join(', ')}`);
      return lines.join('\n');
    }

    case 'MEDIA_APPROVED':
      return `✅ ${name || 'Request Approved'}\n\n${emoji} ${subject}\n\nYour request has been approved and is being processed.`;

    case 'MEDIA_DECLINED':
      return `❌ ${name || 'Request Declined'}\n\n${emoji} ${subject}\n\nYour request has been declined.`;

    case 'MEDIA_FAILED':
      return `❌ Request Processing Failed\n\n${emoji} ${subject}\n\nUnfortunately, your request could not be processed at this time. The administrator has been notified and will investigate.`;

    case 'MEDIA_AVAILABLE':
      return formatMediaAvailable(event, f);

    case 'MEDIA_AUTO_APPROVED':
      return `✅ ${name || 'Request Auto-Approved'}\n\n${emoji} ${subject}\n\nYour request was automatically approved and is being processed.`;

    case 'MEDIA_AUTO_REQUESTED':
      return `🤖 ${name || 'Media Auto-Requested'}\n\n${emoji} ${subject}`;

    case 'ISSUE_CREATED': {
      let msg = `🐛 ${name || 'Issue Reported'}\n\n${emoji} ${subject}\n`;
      msg = addIssueDetails(msg, event);
      return `${msg}\nYour issue has been reported successfully. An administrator will review it and get back to you soon.`;
    }

    case 'ISSUE_COMMENT': {
      let msg = `💬 ${name || 'New Comment on Issue'}\n\n${emoji} ${subject}\n`;
      if (event.issueType) {
        msg += `${getIssueTypeEmoji(event.issueType)} Issue Type: ${formatIssueType(event.issueType)}\n`;
      }
      const comment = event.commentMessage || event.message;
      if (comment) msg += `💬 Comment: ${comment}\n`;
      return `${msg}\nA new comment has been added to your issue.`;
    }

    case 'ISSUE_RESOLVED': {
      let msg = `✅ ${name || 'Issue Resolved'}\n\n${emoji} ${subject}\n`;
      msg = addIssueDetails(msg, event);
      return `${msg}\nYour issue has been marked as resolved. If you still experience problems, you can reopen the issue.`;
    }

    case 'ISSUE_REOPENED': {
      let msg = `⏳ ${name || 'Issue Reopened'}\n\n${emoji} ${subject}\n`;
      msg = addIssueDetails(msg, event);
      return `${msg}\nYour issue has been reopened. An administrator will review it again.`;
    }

    case 'TEST_NOTIFICATION':
      return `🧪 ${name || 'Test Notification'}\n\n${subject}`;

    default:
      return event.message || `🔔 ${name || 'Notification'}\n\n${subject}`;
  }
}

function buildAdminSection(baseMessage: string, lines: string[]): string {
  return `${baseMessage}\n\n━━━ Admin Info ━━━\n${lines.join('\n')}`;
}

export function buildAdminMessage(userMessage: string, event: NormalizedEvent): string {
  const reporterName = event.reporter.username || 'Unknown User';
  const issueId = event.eventIds.issueId;

  switch (event.notificationType) {
    case 'MEDIA_PENDING':
    case 'MEDIA_APPROVED':
    case 'MEDIA_DECLINED':
    // Previously these three fell through to `default` and produced no block at all, which was fine
    // while the block was hardcoded per event. Now that it is an operator toggle, a cell they can switch
    // on has to produce something — the requester lines are what an admin wants here too.
    case 'MEDIA_AVAILABLE':
    case 'MEDIA_AUTO_APPROVED':
    case 'MEDIA_AUTO_REQUESTED':
      return buildAdminSection(userMessage, buildRequesterLines(event));

    case 'MEDIA_FAILED': {
      const arrService = event.mediaType === 'movie' ? 'Radarr' : 'Sonarr';
      const lines = [
        ...buildRequesterLines(event),
        `Failed to add to ${arrService}. Please check system logs and configuration.`,
      ];
      if (event.message) lines.push('', `Error: ${event.message}`);
      return buildAdminSection(userMessage, lines);
    }

    case 'ISSUE_CREATED': {
      const lines = [`👤 Reported by: ${reporterName}`, ...buildIssueAdminLines(issueId, event.issueType)];
      if (event.message) lines.push(`📝 Message: ${event.message}`);
      lines.push('Please review and resolve the issue.');
      return buildAdminSection(userMessage, lines);
    }

    case 'ISSUE_COMMENT': {
      const commenterName = event.commenter.username || reporterName;
      const lines = [`👤 Commented by: ${commenterName}`, ...buildIssueAdminLines(issueId, event.issueType)];
      const comment = event.commentMessage || event.message;
      if (comment) lines.push(`💬 Comment: ${comment}`);
      lines.push('New comment added to issue.');
      return buildAdminSection(userMessage, lines);
    }

    case 'ISSUE_RESOLVED': {
      const lines = [
        `👤 Resolved by: ${event.resolverUsername || reporterName}`,
        ...buildIssueAdminLines(issueId, event.issueType),
      ];
      if (event.message) lines.push(`📝 Message: ${event.message}`);
      lines.push('Issue has been resolved.');
      return buildAdminSection(userMessage, lines);
    }

    case 'ISSUE_REOPENED': {
      const lines = [`👤 Reopened by: ${reporterName}`, ...buildIssueAdminLines(issueId, event.issueType)];
      if (event.message) lines.push(`📝 Message: ${event.message}`);
      lines.push('Issue has been reopened.');
      return buildAdminSection(userMessage, lines);
    }

    default:
      return userMessage;
  }
}

export interface FormattedMessages {
  userMessage: string;
  adminMessage: string;
}

/**
 * Both copies of one notification. `withAdminInfo` is the operator's per-event toggle; when it is off,
 * or the event has nothing to say to an admin, both copies are identical.
 */
export function formatMessages(
  event: NormalizedEvent,
  f: MediaAvailableFlags,
  withAdminInfo = true,
): FormattedMessages {
  const userMessage = formatUserMessage(event, f).trimEnd();
  const adminMessage =
    withAdminInfo && supportsAdminInfo(event.notificationType)
      ? buildAdminMessage(userMessage, event).trimEnd()
      : userMessage;
  return { userMessage, adminMessage };
}
