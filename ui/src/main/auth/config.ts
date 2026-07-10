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
import { dataDir, readAppConfig } from "../daemon.ts";
import { LOOPBACK_REDIRECT_URI } from "./loopback.ts";
import { SCHEME_REDIRECT_URI, type OAuthConfig } from "./oauth.ts";

const nonEmpty = (v: string | undefined): string | undefined => (v && v.length > 0 ? v : undefined);

/** The region for the email-OTP lane's cognito-idp calls, read from the managed-login host
 * (`<prefix>.auth.<region>.amazoncognito.com`). Empty for a non-standard domain → email lane off. */
const regionFromDomain = (domain: string): string => domain.match(/\.auth\.([a-z0-9-]+)\.amazoncognito\.com$/)?.[1] ?? "";

export const resolveOAuthConfig = (): OAuthConfig | null => {
  const packaged = app.isPackaged;
  const cfg = packaged ? readAppConfig(dataDir()) : {};
  const domain = packaged ? cfg.cognitoDomain : nonEmpty(process.env.COLDSTORE_COGNITO_DOMAIN);
  const clientId = packaged ? cfg.cognitoClientId : nonEmpty(process.env.COLDSTORE_COGNITO_CLIENT_ID);
  if (!domain || !clientId) return null;
  return {
    domain,
    clientId,
    redirectUri: packaged ? SCHEME_REDIRECT_URI : LOOPBACK_REDIRECT_URI,
    region: regionFromDomain(domain),
  };
};
