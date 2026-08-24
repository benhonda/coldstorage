/**
 * Exclude-suggestion derivation — the pure half of the two surfaces that offer the daemon's opt-in packs
 * ({@link ExcludeSuggestion}): the **Suggested skips** shelf in Settings and the **drop-time prompt**.
 *
 * Everything here is derived from two facts the daemon already owns — the pack catalogue and the live
 * excludes list — so there is no pack state stored anywhere to drift out of sync with the chips the user
 * actually edits. Remove one pattern from a pack you turned on and it honestly reports itself `partial`
 * rather than lying about being on (PILLAR3: one source of truth, and it's the flat list).
 */
import type { DepositPreviewItem, ExcludeSuggestion } from "../../../daemon/protocol.ts";

/** Where a pack stands, derived from the excludes list. `partial` is a real, reachable state — the user
 *  turned a pack on and then removed one of its chips — and saying so is the honest option; silently
 *  re-adding the missing pattern would undo a deliberate choice. */
export type PackState = "on" | "partial" | "off";

/** The pack's patterns that AREN'T excluded yet — what "turn this on" would add, and nothing more. */
export const missingPatterns = (pack: ExcludeSuggestion, excludes: readonly string[]): string[] => {
  const active = new Set(excludes);
  return pack.patterns.filter((p) => !active.has(p));
};

/** The pack's patterns that ARE excluded right now — what "stop skipping" would remove, and nothing more.
 *
 *  It cannot tell a pattern the pack added from an identical one the user typed by hand, and deliberately
 *  doesn't try: knowing that would mean storing who-added-what, which is the very state we refuse to keep
 *  so that nothing can contradict the flat list. The flat list IS the truth — `build` is excluded, once,
 *  however it got there — and turning the pack off removes it. The chips make that visible either way. */
export const presentPatterns = (pack: ExcludeSuggestion, excludes: readonly string[]): string[] => {
  const active = new Set(excludes);
  return pack.patterns.filter((p) => active.has(p));
};

export const packState = (pack: ExcludeSuggestion, excludes: readonly string[]): PackState => {
  const missing = missingPatterns(pack, excludes).length;
  if (missing === 0) return "on";
  return missing === pack.patterns.length ? "off" : "partial";
};

/** One pack's share of a pending drop: how many files it would skip and how many bytes they weigh. */
export interface DropMatch {
  pack: ExcludeSuggestion;
  files: number;
  bytes: number;
}

/**
 * What a pending deposit would skip, per pack, from the daemon's tagged preview. Packs with nothing in
 * this drop are dropped from the result; the rest sort heaviest-first, because bytes are what the user is
 * actually deciding about (Deep Archive bills a 180-day minimum on every one of them).
 */
export const matchesInDrop = (
  preview: readonly DepositPreviewItem[],
  packs: readonly ExcludeSuggestion[],
): DropMatch[] => {
  const byId = new Map<string, { files: number; bytes: number }>();
  for (const item of preview) {
    if (item.suggestedPack === null) continue;
    const acc = byId.get(item.suggestedPack) ?? { files: 0, bytes: 0 };
    acc.files += 1;
    acc.bytes += item.size;
    byId.set(item.suggestedPack, acc);
  }
  return packs
    .flatMap((pack) => {
      const hit = byId.get(pack.id);
      return hit ? [{ pack, files: hit.files, bytes: hit.bytes }] : [];
    })
    .sort((a, b) => b.bytes - a.bytes);
};

/**
 * The floor for interrupting a drop. A prompt in front of an upload is expensive — it stops a person
 * mid-gesture — so it has to be worth their attention, and "we found 3 stray .o files" is not. Below the
 * floor we stay out of the way and archive them; the Settings shelf is still there for anyone who wants
 * the pack anyway.
 *
 * Either threshold alone qualifies: 50 MB is worth a sentence whatever the file count, and 500 files is
 * worth one whatever they weigh (that many rows is a browser tree nobody can read afterwards).
 */
export const PROMPT_FLOOR = { bytes: 50 * 1024 * 1024, files: 500 } as const;

export const worthPrompting = (matches: readonly DropMatch[]): boolean => {
  const bytes = matches.reduce((n, m) => n + m.bytes, 0);
  const files = matches.reduce((n, m) => n + m.files, 0);
  return bytes >= PROMPT_FLOOR.bytes || files >= PROMPT_FLOOR.files;
};
