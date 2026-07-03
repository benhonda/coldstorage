/** EntitlementManager — the entitlement fetch + subscribe/poll, with mocked fetch + electron shell. */
import { afterEach, describe, expect, mock, test } from "bun:test";

// shell.openExternal is called in subscribe(); stub the electron module before importing the manager.
const opened: string[] = [];
mock.module("electron", () => ({ shell: { openExternal: (u: string) => (opened.push(u), Promise.resolve()) } }));

const { EntitlementManager } = await import("./manager.ts");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  opened.length = 0;
  mock.restore();
});

const jsonResponse = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as Response;

describe("EntitlementManager.refresh", () => {
  test("signed out → unknown/inactive, no fetch", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("should not be called"))) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve(null));
    await m.refresh();
    expect(m.entitlementStatus()).toEqual({ known: false, active: false, checkingOut: false, error: null });
  });

  test("active subscription → known + active", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(200, { active: true }))) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await m.refresh();
    expect(m.entitlementStatus()).toMatchObject({ known: true, active: true });
  });

  test("a backend error sets error but doesn't crash", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(500, {}))) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await m.refresh();
    expect(m.entitlementStatus().error).toContain("500");
  });
});

describe("EntitlementManager.subscribe", () => {
  test("opens the returned checkout URL in the browser", async () => {
    const calls: string[] = [];
    globalThis.fetch = mock((url: string) => {
      calls.push(url);
      if (url.endsWith("/checkout-session")) return Promise.resolve(jsonResponse(200, { url: "https://pay.paddle.test/abc" }));
      return Promise.resolve(jsonResponse(200, { active: false })); // the poll
    }) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await m.subscribe();
    expect(calls[0]).toBe("https://api.test/checkout-session");
    expect(opened).toEqual(["https://pay.paddle.test/abc"]);
    expect(m.entitlementStatus().checkingOut).toBe(true); // polling started
  });

  test("a checkout-session error surfaces and rejects", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(500, { message: "set PADDLE_PRICE_ID" }))) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await expect(m.subscribe()).rejects.toThrow(/PADDLE_PRICE_ID/);
    expect(opened).toHaveLength(0);
    expect(m.entitlementStatus().error).toContain("PADDLE_PRICE_ID");
  });
});
