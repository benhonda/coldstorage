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
    expect(m.entitlementStatus()).toEqual({ known: false, active: false, checkingOut: false, quotaBytes: null, error: null });
  });

  test("active subscription → known + active", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(200, { active: true }))) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await m.refresh();
    expect(m.entitlementStatus()).toMatchObject({ known: true, active: true });
  });

  test("active subscription with a quota → quotaBytes carried through", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(200, { active: true, quotaBytes: 500_000_000_000 }))) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await m.refresh();
    expect(m.entitlementStatus()).toMatchObject({ known: true, active: true, quotaBytes: 500_000_000_000 });
  });

  test("active subscription with no priceId yet → quotaBytes null", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(200, { active: true, quotaBytes: null }))) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await m.refresh();
    expect(m.entitlementStatus()).toMatchObject({ known: true, active: true, quotaBytes: null });
  });

  test("a backend error sets error but doesn't crash", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(500, {}))) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await m.refresh();
    expect(m.entitlementStatus().error).toContain("500");
  });
});

describe("EntitlementManager.subscribe", () => {
  test("posts the chosen priceId and opens the returned checkout URL in the browser", async () => {
    const calls: { url: string; body: string | undefined }[] = [];
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.endsWith("/checkout-session")) return Promise.resolve(jsonResponse(200, { url: "https://pay.paddle.test/abc" }));
      return Promise.resolve(jsonResponse(200, { active: false })); // the poll
    }) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await m.subscribe("pri_1tb_1yr");
    expect(calls[0]).toEqual({ url: "https://api.test/checkout-session", body: JSON.stringify({ priceId: "pri_1tb_1yr" }) });
    expect(opened).toEqual(["https://pay.paddle.test/abc"]);
    expect(m.entitlementStatus().checkingOut).toBe(true); // polling started
  });

  test("a checkout-session error surfaces and rejects", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(400, { message: "unknown priceId" }))) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await expect(m.subscribe("pri_bogus")).rejects.toThrow(/unknown priceId/);
    expect(opened).toHaveLength(0);
    expect(m.entitlementStatus().error).toContain("unknown priceId");
  });
});

describe("EntitlementManager subscription surface", () => {
  const sub = { status: "active", plan: { size: "1 TB", years: 1, priceId: "pri_1", amountCents: 1899, perMonthCents: 158, quotaBytes: 1_000_000_000_000 }, nextBilledAt: "2027-07-10T00:00:00Z", cancelsAt: null, cancelUrl: "https://paddle.test/cancel", updatePaymentMethodUrl: "https://paddle.test/pay" };

  test("getSubscription returns the summary; 404 means never subscribed (null)", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(200, { subscription: sub }))) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    expect(await m.getSubscription()).toMatchObject({ status: "active", plan: { size: "1 TB" } });

    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(404, { message: "no subscription on this account" }))) as unknown as typeof fetch;
    expect(await m.getSubscription()).toBeNull();
  });

  test("changePlan posts the priceId and returns the fresh summary", async () => {
    const calls: { url: string; body: string | undefined }[] = [];
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
      if (url.endsWith("/subscription/change")) return Promise.resolve(jsonResponse(200, { subscription: { ...sub, plan: { ...sub.plan, size: "2 TB" } } }));
      return Promise.resolve(jsonResponse(200, { active: true })); // the post-change refresh
    }) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    const changed = await m.changePlan("pri_2tb");
    expect(calls[0]).toEqual({ url: "https://api.test/subscription/change", body: JSON.stringify({ priceId: "pri_2tb" }) });
    expect(changed.plan?.size).toBe("2 TB");
  });

  test("openManage fetches fresh and opens the right hosted page", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(200, { subscription: sub }))) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await m.openManage("cancel");
    expect(opened).toEqual(["https://paddle.test/cancel"]);
  });
});

describe("EntitlementManager.getCatalog", () => {
  test("returns the plans array from GET /catalog", async () => {
    const plans = [{ size: "1 TB", years: 1, priceId: "pri_1tb_1yr", amountCents: 1899, perMonthCents: 158, quotaBytes: 1_000_000_000_000 }];
    globalThis.fetch = mock((url: string) =>
      url.endsWith("/catalog") ? Promise.resolve(jsonResponse(200, { plans })) : Promise.reject(new Error("unexpected url")),
    ) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve(null));
    expect(await m.getCatalog()).toEqual(plans);
  });

  test("a catalog error rejects with a user-facing message (no stale/empty list)", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(502, { message: "plan catalog unavailable" }))) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve(null));
    await expect(m.getCatalog()).rejects.toThrow(/couldn't load the plans/);
  });
});
