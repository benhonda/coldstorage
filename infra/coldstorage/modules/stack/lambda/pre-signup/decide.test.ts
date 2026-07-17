/**
 * The whole account-linking decision table (decide.ts) — every branch, because a wrong decision
 * here silently forks a zero-knowledge vault (unmergeable) or wrongly blocks a signup.
 */
import { describe, expect, test } from "bun:test";
import { BLOCKED_SIGNUP_MESSAGE, decide, type ExistingUser } from "./decide.js";

const nativeConfirmed: ExistingUser = { username: "uuid-native", status: "CONFIRMED", emailVerified: true, federated: false };
const nativeAbandoned: ExistingUser = { username: "uuid-stale", status: "UNCONFIRMED", emailVerified: false, federated: false };
const googleProfile: ExistingUser = { username: "google_123", status: "EXTERNAL_PROVIDER", emailVerified: true, federated: true };

describe("federated (Google) first sign-in", () => {
  test("links into an existing confirmed native account — the email-first-then-Google path", () => {
    expect(decide({ triggerSource: "PreSignUp_ExternalProvider", emailVerified: true, existing: [nativeConfirmed] })).toEqual({
      action: "linkToExisting",
      destinationUsername: "uuid-native",
    });
  });

  test("no native account → creates a native shell and links — the Google-first path", () => {
    expect(decide({ triggerSource: "PreSignUp_ExternalProvider", emailVerified: true, existing: [] })).toEqual({
      action: "createShellAndLink",
      deleteStaleUsernames: [],
    });
  });

  test("an abandoned UNCONFIRMED native signup is deleted, never linked into (takeover guard)", () => {
    expect(decide({ triggerSource: "PreSignUp_ExternalProvider", emailVerified: true, existing: [nativeAbandoned] })).toEqual({
      action: "createShellAndLink",
      deleteStaleUsernames: ["uuid-stale"],
    });
  });

  test("an UNVERIFIED IdP email never links — proceeds unlinked", () => {
    expect(decide({ triggerSource: "PreSignUp_ExternalProvider", emailVerified: false, existing: [nativeConfirmed] })).toEqual({
      action: "proceed",
    });
  });

  test("another unlinked federated profile is ignored (two IdPs can't merge)", () => {
    expect(decide({ triggerSource: "PreSignUp_ExternalProvider", emailVerified: true, existing: [googleProfile] })).toEqual({
      action: "createShellAndLink",
      deleteStaleUsernames: [],
    });
  });
});

describe("native (email-code) signup", () => {
  test("blocked when an unlinked Google account owns the email — the legacy case", () => {
    expect(decide({ triggerSource: "PreSignUp_SignUp", emailVerified: false, existing: [googleProfile] })).toEqual({
      action: "blockNativeSignUp",
      message: BLOCKED_SIGNUP_MESSAGE,
    });
  });

  test("proceeds when the email is unclaimed", () => {
    expect(decide({ triggerSource: "PreSignUp_SignUp", emailVerified: false, existing: [] })).toEqual({ action: "proceed" });
  });

  test("proceeds when a native user also exists (alias uniqueness handles it, not us)", () => {
    expect(decide({ triggerSource: "PreSignUp_SignUp", emailVerified: false, existing: [googleProfile, nativeConfirmed] })).toEqual({
      action: "proceed",
    });
  });
});

describe("recursion + unknown triggers", () => {
  test("our own shell AdminCreateUser falls straight through (no recursion)", () => {
    expect(decide({ triggerSource: "PreSignUp_AdminCreateUser", emailVerified: true, existing: [] })).toEqual({ action: "proceed" });
  });

  test("an unknown trigger source proceeds untouched", () => {
    expect(decide({ triggerSource: "PreSignUp_SomethingNew", emailVerified: true, existing: [nativeConfirmed] })).toEqual({
      action: "proceed",
    });
  });
});
