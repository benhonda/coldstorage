/** Date + time for a same-week event — "Aug 24, 3:12 PM". One formatter for every "asked / dropped /
 * finished" stamp, so the Downloads and Uploads pages read the same. */
export const when = (unixSeconds: number | null): string => {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};
