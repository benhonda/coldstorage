import { z } from "zod";

/**
 * The onboarding survey — question catalog + answer validation, one SSOT (PILLAR3).
 *
 * Asked once, in the first-run wizard, both questions skippable (they're for us, not the user).
 * Answers are stored as OPTION IDS, never labels, so copy can be reworded without corrupting
 * collected data; the UI mirrors the ids + labels in its wizard view (same hand-mirrored wire
 * convention as ui/src/daemon/protocol.ts). Bump `SURVEY_VERSION` when the QUESTIONS change
 * meaning (not for label rewording) so future readers can segment answers by what was asked.
 */
export const SURVEY_VERSION = 1;

/** "What are you keeping cold?" — multi-select. */
export const KEEPING_OPTIONS = [
  "photos-video",
  "drive-backups",
  "finished-projects",
  "documents-records",
  "media-collection",
  "other",
] as const;

/** "How did you find ColdStorage?" — single-select. */
export const FOUND_VIA_OPTIONS = [
  "friend-colleague",
  "web-search",
  "social-media",
  "youtube-podcast",
  "article-newsletter",
  "other",
] as const;

/**
 * A stored survey. Both answers optional — Skip records nothing for that question — but a
 * submitted answer must come from the catalog (never trust a client-named option id).
 */
export const surveySchema = z.object({
  v: z.literal(SURVEY_VERSION),
  keeping: z.array(z.enum(KEEPING_OPTIONS)).max(KEEPING_OPTIONS.length).optional(),
  foundVia: z.enum(FOUND_VIA_OPTIONS).optional(),
});

export type Survey = z.infer<typeof surveySchema>;
