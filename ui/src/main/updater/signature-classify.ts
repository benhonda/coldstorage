/**
 * The signature POLICY — pure, and deliberately in its own module: {@link ./signature.ts} imports
 * `electron`, which can't be loaded off a Mac, so a test that reached the classifier through it never ran
 * anywhere but macOS. It therefore never ran at all, which is how a codesign flag that doesn't exist
 * shipped. Here the rule that decides whether the app claims it can update itself is testable everywhere.
 */
import type { CodeSignature } from "../../shared/ipc.ts";

/** `Authority=` naming a Developer ID cert is the only thing that makes an install auto-updatable. */
const DEVELOPER_ID = /^Authority=Developer ID Application/m;
/** codesign DESCRIBING the bundle — every `-d` report leads with these `key=value` lines, whatever the
 * signature is. Their presence is what makes "no Developer ID line" a real answer rather than a silence. */
const DESCRIBED = /^(Executable|Identifier|Format|CodeDirectory|Signature)=/m;
/** What codesign prints for a bundle that was never signed. Exits non-zero, describes nothing. */
const NOT_SIGNED = /code object is not signed at all/;

/**
 * Three answers, not two. A missing Developer ID line only means "can't auto-update" when codesign was
 * actually talking about this bundle — otherwise we've read an error message and know nothing.
 * `other` covers every real failing case at once: unsigned, ad-hoc (`Signature=adhoc`, no Authority line),
 * and an Apple Development cert (valid for local runs, never for distribution).
 */
export const classify = (codesignOutput: string): CodeSignature => {
  if (DEVELOPER_ID.test(codesignOutput)) return "developer-id";
  if (NOT_SIGNED.test(codesignOutput) || DESCRIBED.test(codesignOutput)) return "other";
  return "unknown";
};
