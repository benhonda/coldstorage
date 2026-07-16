/** AccountManager — the onboarding-facts fetch + the wizard's writes, with mocked fetch. */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { AccountManager } from "./manager.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

const jsonResponse = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as Response;

/** A fetch stub that records every call and answers GET /account with `account`, PATCH with 204. */
const stubBackend = (account: Record<string, unknown>): { calls: { method: string; body: unknown }[] } => {
  const calls: { method: string; body: unknown }[] = [];
  globalThis.fetch = mock((_url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return Promise.resolve(method === "GET" ? jsonResponse(200, account) : jsonResponse(204, null));
  }) as unknown as typeof fetch;
  return { calls };
};

describe("AccountManager.refresh", () => {
  test("signed out → unknown, no fetch", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("should not be called"))) as unknown as typeof fetch;
    const m = new AccountManager("https://api.test", () => Promise.resolve(null));
    await m.refresh();
    expect(m.accountStatus()).toEqual({ known: false, displayName: null, onboarded: false, recoveryCodeConfirmed: false, error: null });
  });

  test("timestamps become the booleans the wizard derives from", async () => {
    stubBackend({
      displayName: "Sam Tarly",
      termsVersion: "2026-07-16",
      currentTermsVersion: "2026-07-16",
      onboardedAt: "2026-07-16 12:00:00+00",
      recoveryCodeConfirmedAt: null,
    });
    const m = new AccountManager("https://api.test", () => Promise.resolve("idtok"));
    await m.refresh();
    expect(m.accountStatus()).toEqual({
      known: true,
      displayName: "Sam Tarly",
      onboarded: true,
      recoveryCodeConfirmed: false,
      error: null,
    });
  });

  test("stale/absent terms version → a quiet acceptTerms PATCH; current version → none", async () => {
    const stale = stubBackend({ displayName: null, termsVersion: null, currentTermsVersion: "2026-07-16", onboardedAt: null, recoveryCodeConfirmedAt: null });
    const m = new AccountManager("https://api.test", () => Promise.resolve("idtok"));
    await m.refresh();
    await Bun.sleep(0); // the PATCH is fired without await — let it land
    expect(stale.calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ acceptTerms: true }]);

    const current = stubBackend({ displayName: null, termsVersion: "2026-07-16", currentTermsVersion: "2026-07-16", onboardedAt: null, recoveryCodeConfirmedAt: null });
    await m.refresh();
    await Bun.sleep(0);
    expect(current.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  test("a backend error keeps prior facts and fails OPEN (known stays false on first fetch)", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(500, {}))) as unknown as typeof fetch;
    const m = new AccountManager("https://api.test", () => Promise.resolve("idtok"));
    await m.refresh();
    expect(m.accountStatus().known).toBe(false); // the wizard must not run on unknown facts
    expect(m.accountStatus().error).toContain("500");
  });
});

describe("AccountManager writes", () => {
  test("setDisplayName trims, PATCHes, and reflects optimistically", async () => {
    const { calls } = stubBackend({});
    const m = new AccountManager("https://api.test", () => Promise.resolve("idtok"));
    await m.setDisplayName("  Sam Tarly  ");
    expect(calls[0]).toEqual({ method: "PATCH", body: { displayName: "Sam Tarly" } });
    expect(m.accountStatus().displayName).toBe("Sam Tarly");
  });

  test("setDisplayName rejects an empty name without a request", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("should not be called"))) as unknown as typeof fetch;
    const m = new AccountManager("https://api.test", () => Promise.resolve("idtok"));
    await expect(m.setDisplayName("   ")).rejects.toThrow(/enter a name/);
  });

  test("submitSurvey wraps answers in the survey version; skipped questions stay absent", async () => {
    const { calls } = stubBackend({});
    const m = new AccountManager("https://api.test", () => Promise.resolve("idtok"));
    await m.submitSurvey({ keeping: ["photos-video"] });
    expect(calls[0]).toEqual({ method: "PATCH", body: { survey: { v: 1, keeping: ["photos-video"] } } });
  });

  test("completeOnboarding / confirmRecoveryCode record the one-way facts", async () => {
    const { calls } = stubBackend({});
    const m = new AccountManager("https://api.test", () => Promise.resolve("idtok"));
    await m.completeOnboarding();
    await m.confirmRecoveryCode();
    expect(calls.map((c) => c.body)).toEqual([{ onboarded: true }, { recoveryCodeConfirmed: true }]);
    expect(m.accountStatus()).toMatchObject({ onboarded: true, recoveryCodeConfirmed: true });
  });

  test("a failed PATCH rejects with a message (the wizard shows it and moves on)", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(500, {}))) as unknown as typeof fetch;
    const m = new AccountManager("https://api.test", () => Promise.resolve("idtok"));
    await expect(m.setDisplayName("Sam")).rejects.toThrow(/500/);
  });
});
