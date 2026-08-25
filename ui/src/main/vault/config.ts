/**
 * Resolve the account-backend base URL — the LANE the whole app talks to (key-blob, entitlement,
 * billing, account). One seam, because every one of those must agree.
 *
 * **Packaged: the baked file decides, and nothing else can.** The lane is a property of the BUILD, not a
 * user preference — `ui/build/app-config.json`, baked by `task ui:config:bake ENV=…`. Deliberately NOT
 * `readAppConfig`, which merges the user's `config.json` on top: the dev lanes (`app:mac:run:*` →
 * `ui:mac:config`) all write THEIR lane into the production data dir, because Mode 1's daemon and socket
 * live there. So a leftover `accountApiBaseUrl` from one `app:mac:run:staging-local` used to silently
 * repoint an installed production app at staging — sandbox Paddle, and worse, the key-blob written to the
 * TEST database where that user's encrypted master key would be stranded. Running a packaged app against
 * staging has its own supported answer with its own identity and its own data dir
 * (`task app:mac:package:staging` → "ColdStorage Staging.app"), so nothing is lost by refusing here.
 *
 * There is NO fallback: a packaged build with no baked lane is a broken build, and it says so instead of
 * quietly picking one (the wrong guess strands a customer's key in the wrong database).
 *
 * **Dev (unpackaged): `COLDSTORE_ACCOUNT_API` from the environment, and nothing else.** The launching task
 * (`app:mac:run:<lane>`) sets it for THIS process; it is written to no file. It used to
 * be persisted in `config.json`, which four tasks wrote (one with a silent staging default) — so a
 * production-pointed install drifted back to staging between runs, the app said "Free" about a paid
 * account, and the daemon refused deposits over the free-tier quota (2026-08-25). A lane is a property
 * of a launch, not of the machine. Nothing configured ⇒ refuse to start, exactly like a packaged build
 * with no baked lane: there is no safe guess, only an honest one.
 */
import { app } from "electron";
import { readBakedConfig } from "../daemon.ts";

const nonEmpty = (v: string | undefined): string | undefined => (v && v.length > 0 ? v : undefined);

/** Thrown when a packaged build has no baked lane. Caught at startup, which shows it and quits — an app
 * that doesn't know its own backend cannot honestly do anything (PILLAR5: no silent wrong lane). */
export class UnconfiguredLaneError extends Error {
  constructor(packaged: boolean) {
    super(
      packaged
        ? "This build has no account backend configured (Contents/Resources/app-config.json is missing or has no accountApiBaseUrl). " +
            "It was packaged without `task ui:config:bake ENV=production`. Please download ColdStorage again."
        : "No account backend for this dev run (COLDSTORE_ACCOUNT_API is unset). " +
            "Launch through a lane: `task app:mac:run:staging-local` / `:local` / `:production-local`.",
    );
    this.name = "UnconfiguredLaneError";
  }
}

export const resolveAccountApiBaseUrl = (): string => {
  const lane = app.isPackaged ? nonEmpty(readBakedConfig().accountApiBaseUrl) : nonEmpty(process.env.COLDSTORE_ACCOUNT_API);
  if (!lane) throw new UnconfiguredLaneError(app.isPackaged);
  return lane.replace(/\/$/, "");
};
