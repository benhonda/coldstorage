/**
 * The statuses this app throws deliberately, paired with their protocol-default
 * reason phrase. Shared (NOT `.server.ts`) because both ends need it: the server
 * builds `Response.statusText` from it, and the client-side error screen compares
 * against it to tell "nobody wrote copy for this" from a real human message.
 */
export const HTTP_STATUS_TEXT = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
} as const;

/** The statuses `serverError` accepts — add a reason phrase above to add a status. */
export type ServerErrorStatus = keyof typeof HTTP_STATUS_TEXT;

/**
 * True when `statusText` is the protocol's filler for that status rather than
 * something a human wrote — i.e. when the error screen must supply its own copy.
 * Unknown statuses (a 504 from the platform, say) count as generic: we never
 * authored those words either.
 */
export function isGenericStatusText(
  status: number,
  statusText: string,
): boolean {
  const authored = authoredStatusText(status);
  if (!authored) return true;
  return !statusText || statusText === authored;
}

/**
 * The table's phrase for a status, or undefined for a status we never throw.
 *
 * The `in` check is what makes the narrowing cast honest: this stack's tsconfig
 * doesn't set `noUncheckedIndexedAccess`, so a bare
 * `HTTP_STATUS_TEXT[status as ServerErrorStatus]` types as a non-optional literal
 * union — making the unknown-status branch above unreachable code the compiler
 * can't warn about, a type asserting something the runtime disproves.
 */
function authoredStatusText(status: number): string | undefined {
  return status in HTTP_STATUS_TEXT
    ? HTTP_STATUS_TEXT[status as ServerErrorStatus]
    : undefined;
}
