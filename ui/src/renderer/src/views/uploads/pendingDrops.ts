/**
 * The drops the app has taken but the daemon hasn't started uploading yet — what the "Reading…" banner
 * shows, from the moment a folder is released until that deposit's run begins.
 *
 * A deposit has a long life before its run: the preview walk, the skip/collision prompts, then the
 * fire-and-forget `deposit` command — after which the daemon records the batch and waits for any run in
 * flight before starting its own. The app used to show a banner for the preview walk only, and then nothing
 * until the run's first progress tick: a gap of seconds (or, behind a running upload, minutes) in which the
 * banner simply vanished, which read as "did it take it?" (2026-09-03). The gap is closed from both ends:
 * this holds the drop until `runStarted` names its batch, and the run banner shows from `runStarted`
 * onward for a deposit's run (the hash walk inside the run is real work with nothing to count yet).
 *
 * Owned by App, not the file browser, so a trip to another page mid-drop doesn't lose it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RunProgress } from "../../state/reducer.ts";

export interface PendingDrop {
  id: number;
  /** What was dropped, for the banner ("Videos", "photos"). */
  label: string;
  /** The batch id from the deposit ack — `null` until the command is acked (the preview + prompts window). */
  depositId: string | null;
}

export interface PendingDrops {
  drops: readonly PendingDrop[];
  /** A drop was taken: hold it, from now until its run starts. Returns the drop's id. */
  begin: (label: string) => number;
  /** The daemon acked the deposit as `depositId`; the drop leaves on THAT run's start. */
  accepted: (id: number, depositId: string) => void;
  /** The drop isn't happening — cancelled at a prompt, refused by the gate, or rejected by the daemon. */
  cancel: (id: number) => void;
}

let dropSeq = 0;

export const usePendingDrops = (
  run: RunProgress | null,
  /** Batch id → the revision its run finished at — a deposit that ran to completion before its ack was
   * even processed here (a one-file drop on an idle daemon) must not be held for a start already past. */
  depositRuns: Readonly<Record<string, number>>,
  /** The daemon's live error channel. Deposit setup can fail AFTER the ack (fire-and-forget: a photo
   * library that can't be read, a session that closed) — that surfaces as an `error` event and no run ever
   * starts, so an accepted drop must not sit on "Reading…" forever behind it. */
  lastError: string | null,
): PendingDrops => {
  const [drops, setDrops] = useState<PendingDrop[]>([]);
  // The latest run + finished map, readable from `accepted` without re-creating it per render.
  const latest = useRef({ run, depositRuns });
  latest.current = { run, depositRuns };

  // The run for this batch has begun — the run banner takes it from here.
  const runningId = run?.active ? run.depositId : null;
  useEffect(() => {
    if (runningId) setDrops((prev) => prev.filter((d) => d.depositId !== runningId));
  }, [runningId]);

  // Something errored: every accepted drop is suspect (its setup may be the thing that failed), and the
  // honest state for it is no banner rather than a "Reading…" that can never resolve. A drop still in its
  // preview/prompt window is untouched — that path reports its own failures and cancels itself.
  useEffect(() => {
    if (lastError) setDrops((prev) => prev.filter((d) => d.depositId === null));
  }, [lastError]);

  const begin = useCallback((label: string): number => {
    const id = ++dropSeq;
    setDrops((prev) => [...prev, { id, label, depositId: null }]);
    return id;
  }, []);

  const accepted = useCallback((id: number, depositId: string): void => {
    const { run: r, depositRuns: finished } = latest.current;
    const alreadyRunning = (r?.active && r.depositId === depositId) || finished[depositId] !== undefined;
    setDrops((prev) => (alreadyRunning ? prev.filter((d) => d.id !== id) : prev.map((d) => (d.id === id ? { ...d, depositId } : d))));
  }, []);

  const cancel = useCallback((id: number): void => {
    setDrops((prev) => prev.filter((d) => d.id !== id));
  }, []);

  return { drops, begin, accepted, cancel };
};
