/**
 * The signature classifier — the policy that decides whether the app tells the user it can update itself.
 *
 * The fixtures below are real `codesign -dv --verbosity=2` output (trimmed), because the whole risk here
 * is misreading what the tool actually prints: an ad-hoc bundle emits `Signature=adhoc` and NO `Authority`
 * line at all, so a naive "does it mention a signature" check would call it signed and re-create the
 * month-long silent failure this was written for.
 */
import { describe, expect, test } from "bun:test";
import { __classifyForTest as classify } from "./signature.ts";

/** A notarized release build — what `ui:mac:release` produces and the only auto-updatable shape. */
const DEVELOPER_ID = `Executable=/Applications/ColdStorage.app/Contents/MacOS/ColdStorage
Identifier=com.theadpharm.coldstorage
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=30+7
Authority=Developer ID Application: The Adpharm (TEAMID123)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=TEAMID123
Runtime Version=15.0.0`;

/** `ui:mac:package:sign-adhoc` — note there is no Authority line whatsoever. */
const AD_HOC = `Executable=/Applications/ColdStorage.app/Contents/MacOS/ColdStorage
Identifier=com.theadpharm.coldstorage
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=30+7
Signature=adhoc
TeamIdentifier=not set`;

/** What codesign prints (to stderr, exiting non-zero) for a bundle that was never signed. */
const UNSIGNED = `/Applications/ColdStorage.app: code object is not signed at all`;

/** Valid for running locally, never for distribution — Apple refuses to notarize it and Squirrel refuses
 * to update over it. The trap: it HAS Authority lines, so it must not be matched loosely. */
const APPLE_DEVELOPMENT = `Executable=/Applications/ColdStorage.app/Contents/MacOS/ColdStorage
Identifier=com.theadpharm.coldstorage
Authority=Apple Development: ben@theadpharm.com (XYZ123)
Authority=Apple Worldwide Developer Relations Certification Authority
Authority=Apple Root CA
TeamIdentifier=TEAMID123`;

describe("classify", () => {
  test("a Developer ID release is the one auto-updatable shape", () => {
    expect(classify(DEVELOPER_ID)).toBe("developer-id");
  });

  test("ad-hoc reads as unsignable — it has no Authority line at all", () => {
    expect(classify(AD_HOC)).toBe("other");
  });

  test("never signed reads as unsignable", () => {
    expect(classify(UNSIGNED)).toBe("other");
  });

  test("an Apple Development cert is NOT a distribution signature", () => {
    // The subtle one: it has three Authority lines, none of them Developer ID. Matching on the mere
    // presence of "Authority=" — or on "Apple" — would wrongly promise auto-update here.
    expect(classify(APPLE_DEVELOPMENT)).toBe("other");
  });

  test("the Developer ID match is anchored to the start of an Authority line", () => {
    // Defends the regex's ^...m anchor: a cert whose NAME merely contains the phrase must not pass.
    expect(classify("Authority=Not A Developer ID Application: someone")).toBe("other");
  });
});
