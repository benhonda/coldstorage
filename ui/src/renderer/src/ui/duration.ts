/**
 * "How much longer" — the app's ONE duration phrase.
 *
 * There were two for a while (2026-07-27): the deposit banner's `etaLabel` and a separate countdown
 * written for the Transfers page. Same question, same input, two sets of buckets and two voices — an
 * upload said "about 5 min left" while a transfer said "About 1 day 17 hours left". Two hand-maintained
 * tables for one fact is exactly the drift PILLAR3 exists to stop, so there is one function now and both
 * surfaces call it.
 *
 * **Coarse on purpose, for two different reasons that happen to want the same thing.** The upload estimate
 * is derived from a rate the daemon only refreshes per 64 MiB part, so it genuinely wobbles — showing
 * exact seconds made it lurch ("43s" → "12s") every time a part landed. The thaw estimate doesn't wobble
 * at all, but it's AWS's typical case rather than a measurement, so precision there would be a different
 * kind of lie. Friendly buckets, coarser the further out, serve both: the phrase reads as the rough guide
 * it is, not a stopwatch.
 *
 * Returns "" when there's nothing worth saying, so a caller can treat it as "no estimate".
 */

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;

export const timeLeft = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return "under a minute left";

  // Minutes: nearest minute up close, nearest 5 once it's a longer wait — precision matters less the
  // further out you are.
  const mins = seconds / 60;
  const step = mins < 10 ? 1 : 5;
  const roundedMins = Math.max(1, Math.round(mins / step) * step);
  if (roundedMins < 60) return `about ${plural(roundedMins, "minute")} left`;

  // Hours: round to the nearest half-hour and stop there. Sub-hour precision would only wobble.
  // Counted in half-hours rather than hours so the day boundary has no gap — rounding 23h50m to
  // "24 hours" instead of "1 day" is the kind of seam that only shows up in front of a user.
  const halfHours = Math.round(mins / 30);
  if (halfHours < 48) {
    const whole = Math.floor(halfHours / 2);
    const half = halfHours % 2 === 1;
    // The half makes it plural even at one — "1½ hours", never "1½ hour".
    return `about ${whole}${half ? "½" : ""} ${whole === 1 && !half ? "hour" : "hours"} left`;
  }

  // Days: whole days plus whole hours while it's still a wait you might sit through — a thaw spends most
  // of its life here, and this is where the upload banner used to give up and say "about 74 hours left".
  const totalHours = Math.round(halfHours / 2);
  if (totalHours < 3 * 24) {
    const days = Math.floor(totalHours / 24);
    const rest = totalHours % 24;
    return rest === 0
      ? `about ${plural(days, "day")} left`
      : `about ${plural(days, "day")} ${plural(rest, "hour")} left`;
  }

  // Further out, hours are noise: a multi-day upload estimate comes from a two-minute rate window
  // extrapolated across days, and "about 20 days 7 hours" flickering to "about 21 days 2 hours" on every
  // part is precision we do not have. Whole days to two weeks, whole weeks past that.
  const days = Math.round(totalHours / 24);
  if (days < 14) return `about ${plural(days, "day")} left`;
  return `about ${plural(Math.round(days / 7), "week")} left`;
};

/** The same phrase opening a sentence. A standalone line ("About 17 hours left") wants a capital; the
 * deposit banner's `·`-joined strip doesn't, and neither should have to remember which. */
export const timeLeftSentence = (seconds: number): string => {
  const phrase = timeLeft(seconds);
  return phrase === "" ? "" : phrase.charAt(0).toUpperCase() + phrase.slice(1);
};
