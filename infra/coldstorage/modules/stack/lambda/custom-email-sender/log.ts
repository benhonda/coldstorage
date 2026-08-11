/**
 * Log helpers. Its own module so it can be unit-tested without index.ts's cold-start environment
 * reads — a masking bug is a mailbox full of user email addresses sitting in CloudWatch forever.
 */

/**
 * `ben@example.com` → `b**@*******.***` — enough to correlate a log line with a support question,
 * not enough to be a copy of the mailing list. The first character stays because it is the one hint
 * that makes "is this the same person?" answerable; everything after it, including the domain, does
 * not survive. Lengths are preserved deliberately: they're what makes two masked addresses
 * distinguishable at a glance.
 */
export const maskEmail = (email: string): string => {
  const at = email.lastIndexOf("@");
  if (at < 0) return "*".repeat(email.length); // not an address; assume the worst and keep none of it
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}${"*".repeat(Math.max(local.length - 1, 0))}@${domain.replace(/[^.]/g, "*")}`;
};
