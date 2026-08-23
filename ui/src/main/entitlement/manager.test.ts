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

describe("EntitlementManager checkout escape hatches", () => {
  const checkoutFetch = (): typeof fetch =>
    mock((url: string) =>
      url.endsWith("/checkout-session")
        ? Promise.resolve(jsonResponse(200, { url: "https://pay.paddle.test/abc" }))
        : Promise.resolve(jsonResponse(200, { active: false })),
    ) as unknown as typeof fetch;

  test("cancelCheckout drops the waiting state immediately instead of leaving a dead end", async () => {
    globalThis.fetch = checkoutFetch();
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await m.subscribe("pri_1tb_1yr");
    expect(m.entitlementStatus().checkingOut).toBe(true);

    m.cancelCheckout();
    expect(m.entitlementStatus()).toMatchObject({ checkingOut: false, error: null });
    // …and it stays cancelled: the abandoned poll must not resurrect the wait or write a timeout error.
    await new Promise((r) => setTimeout(r, 20));
    expect(m.entitlementStatus()).toMatchObject({ checkingOut: false, error: null });
  });

  test("reopenCheckout reopens the SAME transaction — no second checkout-session call", async () => {
    const posts: string[] = [];
    globalThis.fetch = mock((url: string) => {
      if (url.endsWith("/checkout-session")) {
        posts.push(url);
        return Promise.resolve(jsonResponse(200, { url: "https://pay.paddle.test/abc" }));
      }
      return Promise.resolve(jsonResponse(200, { active: false }));
    }) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await m.subscribe("pri_1tb_1yr");
    await m.reopenCheckout();
    expect(opened).toEqual(["https://pay.paddle.test/abc", "https://pay.paddle.test/abc"]);
    expect(posts).toHaveLength(1);
  });

  test("reopenCheckout with nothing in flight rejects rather than opening a stale page", async () => {
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await expect(m.reopenCheckout()).rejects.toThrow(/no checkout is open/);
    expect(opened).toHaveLength(0);
  });

  test("a cancelled checkout can be started again", async () => {
    globalThis.fetch = checkoutFetch();
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await m.subscribe("pri_1tb_1yr");
    m.cancelCheckout();
    await m.subscribe("pri_1tb_1yr");
    expect(m.entitlementStatus().checkingOut).toBe(true);
    expect(opened).toHaveLength(2);
  });
});

describe("EntitlementManager restore payment", () => {
  // The poll sleeps 4s between checks; fire timers immediately so these stay unit-test fast. Production
  // timing is untouched — the manager just reads the global.
  const realSetTimeout = globalThis.setTimeout;
  const fastTimers = (): void => {
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as unknown as typeof setTimeout;
  };
  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  const job = (over: Record<string, unknown>): Record<string, unknown> => ({
    jobId: "job_1", status: "quoted", quoteCents: 420, billableBytes: 1, allowanceBytes: 0, typicalWait: "about 12 hours", authorized: false, ...over,
  });

  test("no card on file → opens checkout and says so, so the wait can offer to reopen it", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(200, { url: "https://pay.paddle.test/restore" }))) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    expect(await m.startRestorePayment("job_1")).toEqual({ checkoutOpened: true });
    expect(opened).toEqual(["https://pay.paddle.test/restore"]);
  });

  test("saved card charged in place → no browser, and no reopen offered", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(200, { charged: true, url: null }))) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    expect(await m.startRestorePayment("job_1")).toEqual({ checkoutOpened: false });
    expect(opened).toHaveLength(0);
  });

  test("the wait resolves with the job once the webhook authorizes it", async () => {
    fastTimers();
    let checks = 0;
    globalThis.fetch = mock((url: string) => {
      if (url.endsWith("/pay")) return Promise.resolve(jsonResponse(200, { url: "https://pay.paddle.test/restore" }));
      checks += 1;
      return Promise.resolve(jsonResponse(200, job(checks > 1 ? { status: "paid", authorized: true } : {})));
    }) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await m.startRestorePayment("job_1");
    expect(await m.awaitRestorePayment("job_1")).toMatchObject({ authorized: true });
  });

  test("cancelling ends the wait with null (not an error) and hands the quote back", async () => {
    fastTimers();
    const posted: string[] = [];
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      if (init?.method === "POST") posted.push(url);
      if (url.endsWith("/pay")) return Promise.resolve(jsonResponse(200, { url: "https://pay.paddle.test/restore" }));
      return Promise.resolve(jsonResponse(200, job({}))); // never authorizes — they never finish checkout
    }) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await m.startRestorePayment("job_1");
    const waiting = m.awaitRestorePayment("job_1");
    await m.cancelRestorePayment("job_1");
    expect(await waiting).toBeNull();
    expect(posted).toContain("https://api.test/retrieval/jobs/job_1/cancel");
  });

  test("reopen points at the SAME checkout; nothing in flight rejects", async () => {
    globalThis.fetch = mock(() => Promise.resolve(jsonResponse(200, { url: "https://pay.paddle.test/restore" }))) as unknown as typeof fetch;
    const m = new EntitlementManager("https://api.test", () => Promise.resolve("idtok"));
    await expect(m.reopenRestoreCheckout()).rejects.toThrow(/no checkout is open/);
    await m.startRestorePayment("job_1");
    await m.reopenRestoreCheckout();
    expect(opened).toEqual(["https://pay.paddle.test/restore", "https://pay.paddle.test/restore"]);
    await m.cancelRestorePayment("job_1");
    await expect(m.reopenRestoreCheckout()).rejects.toThrow(/no checkout is open/);
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
