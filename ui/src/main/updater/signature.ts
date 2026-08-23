/**
 * What code signature this install carries — the difference between an app that can auto-update and one
 * that silently can't.
 *
 * macOS applies updates through Squirrel.Mac, which verifies the incoming bundle's signature against the
 * running one. A Developer ID signed release therefore cannot replace an ad-hoc, unsigned, or
 * Apple-Development signed build: the swap fails at install time, long after the check and the download
 * both appeared to work. That failure mode cost a month of "it just doesn't update" once already — a
 * locally packaged, ad-hoc signed build sitting in /Applications, re-failing on every launch.
 *
 * So the app reads its own signature and says so up front, instead of letting the user discover it from a
 * download that never lands (PILLAR5). `task ui:mac:update:doctor` reports the same fact from outside.
 *
 * There is no Electron API for this and the Security-framework call (`SecCodeCopySigningInformation`)
 * would need a native addon, so we ask `codesign` — once per process, memoized.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import type { CodeSignature } from "../../shared/ipc.ts";

const run = promisify(execFile);

/** The .app bundle root, from the executable macOS launched: <app>.app/Contents/MacOS/<exe> → up three. */
const bundlePath = (): string => join(app.getPath("exe"), "..", "..", "..");

/** `Authority=` naming a Developer ID cert is the only thing that makes an install auto-updatable. Its
 * absence covers every failing case at once: unsigned, ad-hoc (`Signature=adhoc`, no Authority line), and
 * an Apple Development cert (valid for local runs, never for distribution). */
const classify = (codesignOutput: string): CodeSignature =>
  /^Authority=Developer ID Application/m.test(codesignOutput) ? "developer-id" : "other";

const detect = async (): Promise<CodeSignature> => {
  // Unpackaged or non-macOS: there's no install to inspect and no Squirrel to satisfy, so claim nothing
  // rather than reporting a shape of "unsigned" the UI would have to special-case back out of.
  if (!app.isPackaged || process.platform !== "darwin") return "unknown";
  try {
    // codesign writes its description to STDERR, including on success.
    const { stderr } = await run("codesign", ["-dv", "--verbosity=2", bundlePath()]);
    return classify(stderr);
  } catch (e) {
    // An unsigned bundle EXITS NON-ZERO ("code object is not signed at all") — a rejection here is a real
    // answer, not an error, so read the same stderr off it. Only a genuinely absent/broken codesign
    // (no stderr to classify) falls through to "unknown".
    const stderr = typeof e === "object" && e !== null ? (e as { stderr?: unknown }).stderr : undefined;
    return typeof stderr === "string" ? classify(stderr) : "unknown";
  }
};

let cached: Promise<CodeSignature> | null = null;

/** This install's signature. Static for the life of the process — resolved once, then handed out. */
export const codeSignature = (): Promise<CodeSignature> => (cached ??= detect());

/** Test seam: `classify` is the whole policy, and it's pure. */
export const __classifyForTest = classify;
