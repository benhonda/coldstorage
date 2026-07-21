/**
 * The packaged app's config seam — pure, electron-free, so it's unit-testable (the electron glue that
 * picks the file *paths* lives in daemon.ts). PROD.md Phase 6d: a customer download self-configures
 * because the public, non-secret config is BAKED into the bundle at package time (from the same
 * infra-outputs handoff `task ui:mac:config` uses), and the user's own `config.json` (dev/dogfood) merely
 * OVERRIDES it. So the resolution is always: baked base ← user override.
 *
 * NO secret ever lives here. Customer AWS creds resolve via Cognito → short-lived STS (coldstored/main.swift),
 * so the baked config deliberately omits `awsProfile` — that's the dogfood credential_process path only.
 */
import { readFileSync } from "node:fs";

/** The packaged app's per-user config. Every value is public (bucket/region/Cognito ids are client
 * config, not secrets — see cognito.tf); `awsProfile` is the dogfood-only credential_process path. */
export type AppConfig = {
  /** App INSTALL IDENTITY for this build's lane (baked from ui/identity.json by `task ui:config:bake`).
   * `productName` pins {@link app.setName} → the userData dir (data/socket/logs/vault); `scheme` is the
   * deep-link + OAuth-redirect URL scheme. Distinct per lane so a staging build installs alongside prod.
   * Absent in dev (unpackaged, no baked file) ⇒ prod identity (ColdStorage / coldstorage). (The bundle's
   * matching `appId` is baked too but the runtime doesn't need it, so it's not parsed here.) */
  productName?: string | undefined;
  scheme?: string | undefined;
  bucket?: string | undefined;
  region?: string | undefined;
  awsProfile?: string | undefined;
  cognitoIdentityPoolId?: string | undefined;
  cognitoUserPoolProvider?: string | undefined;
  cognitoDomain?: string | undefined;
  cognitoClientId?: string | undefined;
  /** Account-backend base URL (Phase 5b) — where the app fetches/stores the zero-knowledge key-blob and
   * checks entitlement. Absent everywhere ⇒ vault/config.ts's staging default. */
  accountApiBaseUrl?: string | undefined;
};

/** The keys we accept, in one place so parse + merge stay in lockstep. */
const CONFIG_KEYS = [
  "productName",
  "scheme",
  "bucket",
  "region",
  "awsProfile",
  "cognitoIdentityPoolId",
  "cognitoUserPoolProvider",
  "cognitoDomain",
  "cognitoClientId",
  "accountApiBaseUrl",
] as const;

/** Parse a config.json string into an {@link AppConfig}, keeping only non-empty string fields (an empty
 * string is treated as "not set" — the handoff writes blanks for values that aren't configured yet, e.g.
 * Cognito before Phase 2c). Throws on non-object/invalid JSON so the caller can log + degrade. */
export const parseAppConfig = (raw: string): AppConfig => {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not a JSON object");
  const o = parsed as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const out: AppConfig = {};
  for (const k of CONFIG_KEYS) out[k] = str(o[k]);
  return out;
};

/** Read + parse a config file best-effort. Missing file ⇒ `{}` **silently** (a customer has no user
 * `config.json`, and the packaged app has no baked file in dev — both are normal in the layered model).
 * Malformed JSON ⇒ `{}` with a warning (a real mistake worth surfacing). */
export const readConfigFile = (path: string): AppConfig => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  try {
    return parseAppConfig(raw);
  } catch (e) {
    console.error(`ignoring malformed ${path}: ${String(e)}`);
    return {};
  }
};

/** Merge two configs: `override`'s defined keys win, `base` fills the gaps. An `undefined` key in
 * `override` does NOT clobber `base` (that's the whole point — the baked base survives where the user
 * file is silent). */
export const mergeAppConfig = (base: AppConfig, override: AppConfig): AppConfig => {
  const out: AppConfig = {};
  for (const k of CONFIG_KEYS) out[k] = override[k] ?? base[k];
  return out;
};
