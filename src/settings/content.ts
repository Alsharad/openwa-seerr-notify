// Which sections a media notification renders, as operator-editable config.
//
// This started as MediaAvailableFlags in config.ts, hardcoded to all-on: nine toggles for one message
// type was judged more surface than the decision deserved. The operator asked for them back as a tab,
// so the type moved here — next to routing.ts, which is the same shape of decision (a table of cells the
// editor renders and the plugin merges over defaults) and now the same shape of code.
//
// Two differences from that first version. Rating and runtime were one flag and are now two, because
// they are two facts and an operator who wants a score does not necessarily want a duration. And the
// flags govern Request Submitted as well as Now Available: a tab that says "Plot summary: off" while a
// Request Submitted message still carries the plot is the kind of half-applied switch that reads as a bug.

/** Every section an operator can switch off, in the order the editor lists them. */
export const CONTENT_SECTIONS = [
  'showOverview',
  'showRating',
  'showRuntime',
  'showReleaseDate',
  'showGenres',
  'showCast',
  'showDirector',
  'showTrailer',
  'showSeasons',
  'showCollection',
] as const;

export type ContentSection = (typeof CONTENT_SECTIONS)[number];

/** One boolean per section. Every branch of the formatter reads exactly one of these. */
export type ContentFlags = Record<ContentSection, boolean>;

/**
 * Everything on — what the plugin did before any of this was configurable, and what a fresh install or
 * an upgraded one resolves to. Upgrading must not silently thin anyone's messages out.
 */
export const DEFAULT_CONTENT: ContentFlags = Object.freeze(
  Object.fromEntries(CONTENT_SECTIONS.map((section) => [section, true])),
) as ContentFlags;

/**
 * Merge stored content flags over the defaults. Unknown keys are ignored and missing ones fall back, so
 * a config written by an older version — which has no `content` key at all — still resolves to the
 * everything-on behaviour it was running with.
 */
export function readContent(raw: unknown): ContentFlags {
  const flags: ContentFlags = { ...DEFAULT_CONTENT };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return flags;

  const stored = raw as Record<string, unknown>;
  for (const section of CONTENT_SECTIONS) {
    if (typeof stored[section] === 'boolean') flags[section] = stored[section];
  }
  return flags;
}
