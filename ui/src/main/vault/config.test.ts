/**
 * The LANE rule (`resolveAccountApiBaseUrl`). This is the seam that shipped the wrong backend: a
 * `config.json` written by a dev lane silently repointed an installed PRODUCTION app at staging, because
 * `ui:mac:config` writes every lane's config into the production data dir. So the rule gets real tests —
 * the packaged build must be immune to that file, and must refuse to guess when it has no baked lane.
 *
 * Electron is stubbed (`app.isPackaged`) and the two config readers are stubbed at the daemon.ts module
 * seam, so this exercises the real precedence logic rather than the filesystem.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppConfig } from "../config.ts";

let packaged = true;
let baked: AppConfig = {};
let merged: AppConfig = {};

mock.module("electron", () => ({
  app: {
    get isPackaged(): boolean {
      return packaged;
    },
  },
}));
mock.module("../daemon.ts", () => ({
  dataDir: () => "/tmp/does-not-matter",
  readBakedConfig: () => baked,
  readAppConfig: () => merged,
}));

const { resolveAccountApiBaseUrl, UnconfiguredLaneError } = await import("./config.ts");

const PROD = "https://api.coldstorage.sh";
const STAGING = "https://api-staging.coldstorage.sh";

beforeEach(() => {
  packaged = true;
  baked = {};
  merged = {};
  delete process.env.COLDSTORE_ACCOUNT_API;
});
afterEach(() => {
  delete process.env.COLDSTORE_ACCOUNT_API;
});

describe("resolveAccountApiBaseUrl — packaged", () => {
  test("uses the baked lane", () => {
    baked = { accountApiBaseUrl: PROD };
    expect(resolveAccountApiBaseUrl()).toBe(PROD);
  });

  test("a leftover dev config.json CANNOT repoint a production build (the shipped bug)", () => {
    baked = { accountApiBaseUrl: PROD };
    merged = { accountApiBaseUrl: STAGING }; // what `task app:mac:run:staging-local` leaves behind
    expect(resolveAccountApiBaseUrl()).toBe(PROD);
  });

  test("COLDSTORE_ACCOUNT_API in the environment cannot repoint it either", () => {
    baked = { accountApiBaseUrl: PROD };
    process.env.COLDSTORE_ACCOUNT_API = STAGING;
    expect(resolveAccountApiBaseUrl()).toBe(PROD);
  });

  test("no baked lane throws rather than guessing — a wrong guess strands the key blob in the test DB", () => {
    merged = { accountApiBaseUrl: STAGING };
    expect(() => resolveAccountApiBaseUrl()).toThrow(UnconfiguredLaneError);
    expect(() => resolveAccountApiBaseUrl()).toThrow(/download ColdStorage again/);
  });

  test("an empty baked lane counts as absent", () => {
    baked = { accountApiBaseUrl: "" };
    expect(() => resolveAccountApiBaseUrl()).toThrow(UnconfiguredLaneError);
  });

  test("a trailing slash is trimmed (paths are joined as `${base}/entitlement`)", () => {
    baked = { accountApiBaseUrl: `${PROD}/` };
    expect(resolveAccountApiBaseUrl()).toBe(PROD);
  });
});

describe("resolveAccountApiBaseUrl — dev", () => {
  beforeEach(() => {
    packaged = false;
  });

  test("the environment IS the lane — what the launching task passed for this process", () => {
    process.env.COLDSTORE_ACCOUNT_API = "http://localhost:3000";
    expect(resolveAccountApiBaseUrl()).toBe("http://localhost:3000");
  });

  test("a config.json CANNOT supply the lane (the file that drifted a prod-pointed run back to staging)", () => {
    merged = { accountApiBaseUrl: STAGING };
    expect(() => resolveAccountApiBaseUrl()).toThrow(UnconfiguredLaneError);
  });

  test("nothing configured ⇒ refuse to start with the lane tasks named, never a silent default", () => {
    expect(() => resolveAccountApiBaseUrl()).toThrow(/app:mac:run:staging-local/);
  });

  test("an empty env var counts as absent", () => {
    process.env.COLDSTORE_ACCOUNT_API = "";
    expect(() => resolveAccountApiBaseUrl()).toThrow(UnconfiguredLaneError);
  });
});
