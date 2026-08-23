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
 * **Dev (unpackaged): `COLDSTORE_ACCOUNT_API`, then the `config.json` the `app:mac:run:*` lanes write.**
 * That file is how those lanes communicate the lane they gated on — reading only the env var meant
 * `app:mac:run:production-local` ran the app against the staging default while announcing LIVE MONEY.
 * Nothing configured at all ⇒ staging: sandbox Paddle, so a bare `task ui:mac:live` cannot charge a card.
 */
import { app } from "electron";
import { dataDir, readAppConfig, readBakedConfig } from "../daemon.ts";

/** Dev-only. A packaged build never falls back — see above. */
const DEV_DEFAULT_ACCOUNT_API = "https://api-staging.coldstorage.sh";

const nonEmpty = (v: string | undefined): string | undefined => (v && v.length > 0 ? v : undefined);

/** Thrown when a packaged build has no baked lane. Caught at startup, which shows it and quits — an app
 * that doesn't know its own backend cannot honestly do anything (PILLAR5: no silent wrong lane). */
export class UnconfiguredLaneError extends Error {
  constructor() {
    super(
      "This build has no account backend configured (Contents/Resources/app-config.json is missing or has no accountApiBaseUrl). " +
        "It was packaged without `task ui:config:bake ENV=production`. Please download ColdStorage again.",
    );
    this.name = "UnconfiguredLaneError";
  }
}

export const resolveAccountApiBaseUrl = (): string => {
  if (app.isPackaged) {
    const baked = nonEmpty(readBakedConfig().accountApiBaseUrl);
    if (!baked) throw new UnconfiguredLaneError();
    return baked.replace(/\/$/, "");
  }
  const configured = nonEmpty(process.env.COLDSTORE_ACCOUNT_API) ?? nonEmpty(readAppConfig(dataDir()).accountApiBaseUrl);
  if (!configured) {
    console.warn(
      `no account backend configured (COLDSTORE_ACCOUNT_API, or accountApiBaseUrl in ${dataDir()}/config.json) — using ${DEV_DEFAULT_ACCOUNT_API}. Pick a lane with \`task app:mac:run:staging-local\` / \`:local\` / \`:production-local\`.`,
    );
  }
  return (configured ?? DEV_DEFAULT_ACCOUNT_API).replace(/\/$/, "");
};
