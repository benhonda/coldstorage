import { describe, expect, test } from "bun:test";
import { mergeAppConfig, parseAppConfig } from "./config.ts";

describe("parseAppConfig", () => {
  test("keeps non-empty string fields", () => {
    const cfg = parseAppConfig(
      JSON.stringify({ bucket: "vault", region: "ca-central-1", cognitoClientId: "abc123" }),
    );
    expect(cfg.bucket).toBe("vault");
    expect(cfg.region).toBe("ca-central-1");
    expect(cfg.cognitoClientId).toBe("abc123");
  });

  test("treats an empty string as not set (the handoff writes blanks for unconfigured values)", () => {
    const cfg = parseAppConfig(JSON.stringify({ bucket: "vault", cognitoDomain: "" }));
    expect(cfg.bucket).toBe("vault");
    expect(cfg.cognitoDomain).toBeUndefined();
  });

  test("ignores unknown keys and non-string values", () => {
    const cfg = parseAppConfig(JSON.stringify({ bucket: "vault", region: 5, extra: "x" }));
    expect(cfg.bucket).toBe("vault");
    expect(cfg.region).toBeUndefined();
    expect((cfg as Record<string, unknown>).extra).toBeUndefined();
  });

  test("throws on a non-object", () => {
    expect(() => parseAppConfig("[]")).toThrow();
    expect(() => parseAppConfig("null")).toThrow();
    expect(() => parseAppConfig("not json")).toThrow();
  });
});

describe("mergeAppConfig (baked base ← user override)", () => {
  const baked = {
    bucket: "prod-vault",
    region: "ca-central-1",
    cognitoIdentityPoolId: "pool-1",
    cognitoUserPoolProvider: "cognito-idp.ca-central-1.amazonaws.com/up_1",
    cognitoDomain: "coldstorage-prod.auth.ca-central-1.amazoncognito.com",
    cognitoClientId: "client-1",
    accountApiBaseUrl: "https://api.coldstorage.sh",
  };

  test("a config-less customer (empty user file) gets the full baked prod config", () => {
    const cfg = mergeAppConfig(baked, {});
    expect(cfg).toEqual(baked);
  });

  test("user override wins per-key; baked fills the gaps", () => {
    const cfg = mergeAppConfig(baked, { bucket: "minio-test", awsProfile: "coldstorage" });
    expect(cfg.bucket).toBe("minio-test"); // overridden
    expect(cfg.awsProfile).toBe("coldstorage"); // user-only (never baked — dogfood cred path)
    expect(cfg.region).toBe("ca-central-1"); // from baked
    expect(cfg.cognitoClientId).toBe("client-1"); // from baked → sign-in still works
  });

  test("an undefined user key does NOT clobber the baked value", () => {
    const cfg = mergeAppConfig(baked, { bucket: undefined, region: "us-east-1" });
    expect(cfg.bucket).toBe("prod-vault"); // survived the undefined
    expect(cfg.region).toBe("us-east-1");
  });

  test("no baked config (dev) falls back to the user file alone", () => {
    const cfg = mergeAppConfig({}, { bucket: "dev", cognitoClientId: "dev-client" });
    expect(cfg.bucket).toBe("dev");
    expect(cfg.cognitoClientId).toBe("dev-client");
    expect(cfg.accountApiBaseUrl).toBeUndefined();
  });
});
