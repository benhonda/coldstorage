/**
 * The words for WHY an upload failed — one place, keyed by the daemon's `FileFailureKind`.
 *
 * The journal used to store the sentence itself, so every surface that showed a failure showed whatever
 * wording the daemon of the day had written onto the row: last month's copy on last month's rows,
 * truncated where it didn't fit, and one cause fragmented into as many "reasons" as there had been
 * phrasings. Now the row carries the kind and the app owns the words, so a change here changes every
 * failed row everywhere, including ones written before the change. The daemon's `error` is developer
 * detail (an S3 code, a thrown message) and is never the sentence.
 */
import type { FileFailureKind } from "../../../../shared/ipc.ts";
import type { ArchivedFile } from "../files/model.ts";

export interface FailureCopy {
  /** The short form — a badge, a tooltip's tail, a group heading. */
  label: string;
  /** The full sentence — what happened and, where it isn't obvious from the buttons, what it means. */
  explain: string;
}

export const FAILURE = {
  interrupted: {
    label: "Upload was interrupted",
    explain: "ColdStorage stopped before these went up, and nothing picked them back up. They aren't in your backup yet.",
  },
  missingSource: {
    label: "Can't find the file",
    explain: "It isn't where it was when you added it. Plug the drive back in and try again, or use Locate… to point at it.",
  },
  permanent: {
    label: "Couldn't upload",
    explain: "Something went wrong on the way up, and trying the same thing again won't fix it.",
  },
  overQuota: {
    label: "Out of room",
    explain: "There isn't enough space left in your plan for these. They go up once there is.",
  },
  stopped: {
    label: "Stopped",
    explain: "You stopped this before it finished. It picks back up on its own the next time ColdStorage runs.",
  },
} satisfies Record<FileFailureKind, FailureCopy>;

/** The order failures list in, worst-for-the-user first: the ones that need a hand before the ones that
 * heal by themselves. Checked complete at compile time (below), so a kind added to the type can't be
 * left out of the list and silently dropped by `groupFailures`. */
export const FAILURE_ORDER = ["interrupted", "missingSource", "permanent", "overQuota", "stopped"] as const satisfies readonly FileFailureKind[];
type MissingFromOrder = Exclude<FileFailureKind, (typeof FAILURE_ORDER)[number]>;
const everyKindIsOrdered: MissingFromOrder extends never ? true : never = true;
void everyKindIsOrdered;

/** The tail a ⚠ row's tooltip / Get info line gets — the kind's label, never the raw `error`. Null when
 * there's nothing to say (not failed, or a failed row from before kinds existed). */
export const failureReason = (file: Pick<ArchivedFile, "status" | "failureKind">): string | null =>
  file.status === "failed" && file.failureKind ? FAILURE[file.failureKind].label : null;
