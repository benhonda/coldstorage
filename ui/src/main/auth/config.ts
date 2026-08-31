/**
 * Resolve the app's sign-in (OAuth) config — or null, which means "sign-in not configured" and the
 * whole auth surface disappears (single-operator dogfood mode, unchanged).
 *
 * Packaged: from `config.json` (written by `task ui:mac:config` from the infra-outputs handoff — the
 * same file the daemon supervisor reads, because a Finder-launched app inherits no shell env).
 * Dev: from env (`task ui:mac:dev` sources the handoff), with the loopback redirect because an
 * unpackaged Electron can't receive custom-scheme deep links on macOS (see loopback.ts).
 */
import { app } from "electron";
import { appIdentity, dataDir, readAppConfig } from "../daemon.ts";
import { LOOPBACK_REDIRECT_URI } from "./loopback.ts";
import { relayRedirectUri, type OAuthConfig } from "./oauth.ts";

const nonEmpty = (v: string | undefined): string | undefined => (v && v.length > 0 ? v : undefined);

export const resolveOAuthConfig = (): OAuthConfig | null => {
  const packaged = app.isPackaged;
  const cfg = packaged ? readAppConfig(dataDir()) : {};
  const domain = packaged ? cfg.cognitoDomain : nonEmpty(process.env.COLDSTORE_COGNITO_DOMAIN);
  const clientId = packaged ? cfg.cognitoClientId : nonEmpty(process.env.COLDSTORE_COGNITO_CLIENT_ID);
  if (!domain || !clientId) return null;
  return {
    domain,
    clientId,
    // Packaged: this lane's relay page on the site, which hands off to the lane's own scheme
    // (coldstorage:// or coldstorage-staging://) so a staging sign-in routes back to the staging
    // app, not prod. Dev: the loopback listener (unpackaged Electron can't receive deep links).
    redirectUri: packaged ? relayRedirectUri(appIdentity().scheme) : LOOPBACK_REDIRECT_URI,
    // The pool's region, taken from the SAME field the daemon and the bucket use — it is one infra
    // output (`aws_region`), already carried by config.json and the dev handoff, so there is exactly
    // one spelling of it (PILLAR3). It used to be REGEXED BACK OUT of the managed-login hostname,
    // which quietly tied the email-OTP lane to the host happening to end in `.amazoncognito.com`:
    // moving sign-in to `auth.coldstorage.sh` (2026-08-10) would have yielded an empty region and
    // silently disabled email sign-in, with Google still working and nothing logged.
    region: (packaged ? cfg.region : nonEmpty(process.env.AWS_REGION)) ?? "",
  };
};
