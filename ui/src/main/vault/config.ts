/**
 * Resolve the account-backend base URL the vault client talks to (PROD.md Phase 5b). Packaged: from
 * `config.json` (`task ui:mac:config`); dev: from `COLDSTORE_ACCOUNT_API`. Defaults to the staging lane —
 * which accepts production Cognito tokens (staging shares the production user pool), so vault
 * provisioning works end-to-end against staging today; the production lane just overrides this URL.
 */
import { app } from "electron";
import { dataDir, readAppConfig } from "../daemon.ts";

const DEFAULT_ACCOUNT_API = "https://api-staging.coldstorage.sh";

const nonEmpty = (v: string | undefined): string | undefined => (v && v.length > 0 ? v : undefined);

export const resolveAccountApiBaseUrl = (): string => {
  const configured = app.isPackaged
    ? readAppConfig(dataDir()).accountApiBaseUrl
    : nonEmpty(process.env.COLDSTORE_ACCOUNT_API);
  return (configured ?? DEFAULT_ACCOUNT_API).replace(/\/$/, "");
};
