/**
 * Subscription entitlement (PROD.md Phase 5c) — the billing half of being able to back up. Fetches
 * `GET /entitlement` (is the sub active?) and drives checkout: `POST /checkout-session` creates the
 * Paddle transaction server-side (carrying `cognitoSub`), we open its hosted-checkout URL in the system
 * browser, and then POLL `/entitlement` until the webhook flips it active — the webhook is the source of
 * truth, the browser round-trip is not. A `coldstorage://checkout-complete` deep link, if it arrives,
 * is just a "check now" nudge into the same poll.
 *
 * The DEPOSIT gate is SOFT: it stops the app starting an upload, not S3 at the IAM layer (see the backend
 * entitlement route). Browsing stays open unsubscribed.
 *
 * Restore is a different story since 2026-07-13 (root `RETRIEVAL.md`). It is still always AVAILABLE —
 * you can always get your data back, subscribed or not, and small restores are free under a monthly
 * allowance — but it is now PRICED at cost beyond that allowance, and enforced HARD: a signed-in daemon
 * holds no `s3:RestoreObject`, so only the backend can thaw a blob, and only for a restore that's paid
 * for. See the retrieval methods at the bottom of this class.
 */
import { shell } from "electron";
import type { CatalogPlan, EntitlementStatus, ManagePage, PlanChangePreview, RetrievalQuote, SubscriptionInfo } from "../../shared/ipc.ts";

/** How long checkout polling runs before giving up (checkout + webhook delivery); and the gap between polls. */
const POLL_TIMEOUT_MS = 3 * 60 * 1000;
const POLL_INTERVAL_MS = 4000;

const fetchJson = async (url: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new Error(e instanceof DOMException && e.name === "TimeoutError" ? "the billing server didn't respond in time" : "couldn't reach the billing server");
  }
};

export class EntitlementManager {
  private status: EntitlementStatus = { known: false, active: false, checkingOut: false, quotaBytes: null, error: null };
  private polling = false;
  private readonly listeners = new Set<(s: EntitlementStatus) => void>();

  constructor(
    private readonly baseUrl: string,
    private readonly getIdToken: () => Promise<string | null>,
  ) {}

  entitlementStatus(): EntitlementStatus {
    return this.status;
  }

  onStatus(listener: (s: EntitlementStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-read entitlement from the backend. No-op (silent) when signed out. */
  async refresh(): Promise<void> {
    const idToken = await this.getIdToken();
    if (!idToken) {
      this.setStatus({ known: false, active: false, checkingOut: false, quotaBytes: null, error: null });
      return;
    }
    try {
      const res = await fetchJson(`${this.baseUrl}/entitlement`, { headers: { Authorization: `Bearer ${idToken}` } });
      if (!res.ok) throw new Error(`entitlement check failed: http ${res.status}`);
      const body: unknown = await res.json().catch(() => null);
      const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
      const active = record?.active === true;
      const quotaBytes = typeof record?.quotaBytes === "number" ? record.quotaBytes : null;
      this.setStatus({ ...this.status, known: true, active, quotaBytes, error: null });
    } catch (e) {
      this.setStatus({ ...this.status, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Reset to signed-out (called on sign-out) so a next user doesn't inherit this one's entitlement. */
  reset(): void {
    this.polling = false;
    this.setStatus({ known: false, active: false, checkingOut: false, quotaBytes: null, error: null });
  }

  /**
   * The sellable plan catalog for the picker — fetched live (no cache here; the backend holds a
   * short-TTL one), so a reopened modal can recover from a transient failure by refetching.
   */
  async getCatalog(): Promise<CatalogPlan[]> {
    const res = await fetchJson(`${this.baseUrl}/catalog`, {});
    const body: unknown = await res.json().catch(() => null);
    const plans = typeof body === "object" && body !== null ? (body as Record<string, unknown>).plans : undefined;
    if (!res.ok || !Array.isArray(plans)) {
      throw new Error(`couldn't load the plans: http ${res.status}`);
    }
    return plans as CatalogPlan[];
  }

  /** An authenticated JSON call against the billing server; parses the body and throws its `message` on failure. */
  private async authedJson<T>(path: string, init?: RequestInit): Promise<{ res: Response; body: T }> {
    const idToken = await this.getIdToken();
    if (!idToken) throw new Error("sign in first");
    const res = await fetchJson(`${this.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json", ...init?.headers },
    });
    const body = (await res.json().catch(() => null)) as T;
    return { res, body };
  }

  /** The live subscription summary (plan badge + manage surface). Null = never subscribed (404). */
  async getSubscription(): Promise<SubscriptionInfo | null> {
    const { res, body } = await this.authedJson<{ subscription?: SubscriptionInfo; message?: string }>("/subscription");
    if (res.status === 404) return null;
    if (!res.ok || !body?.subscription) throw new Error(body?.message ?? `couldn't load the subscription: http ${res.status}`);
    return body.subscription;
  }

  /** Preview what changing to `priceId` charges (or credits) right now. Read-only. */
  async previewPlanChange(priceId: string): Promise<PlanChangePreview> {
    const { res, body } = await this.authedJson<PlanChangePreview & { message?: string }>("/subscription/change/preview", {
      method: "POST",
      body: JSON.stringify({ priceId }),
    });
    if (!res.ok) throw new Error(body?.message ?? `couldn't preview the change: http ${res.status}`);
    return body;
  }

  /** Apply the plan change (prorated immediately), then re-check entitlement. */
  async changePlan(priceId: string): Promise<SubscriptionInfo> {
    const { res, body } = await this.authedJson<{ subscription?: SubscriptionInfo; message?: string }>("/subscription/change", {
      method: "POST",
      body: JSON.stringify({ priceId }),
    });
    if (!res.ok || !body?.subscription) throw new Error(body?.message ?? `couldn't change the plan: http ${res.status}`);
    void this.refresh();
    return body.subscription;
  }

  /** Open a Paddle-HOSTED management page in the system browser. Fetched fresh — the URLs are
   * session-ish links off the live subscription entity, not stable enough to cache. */
  async openManage(page: ManagePage): Promise<void> {
    const { res, body } = await this.authedJson<{
      subscription?: { cancelUrl: string | null; updatePaymentMethodUrl: string | null };
      message?: string;
    }>("/subscription");
    if (!res.ok || !body?.subscription) throw new Error(body?.message ?? `couldn't load the subscription: http ${res.status}`);
    const url = page === "cancel" ? body.subscription.cancelUrl : body.subscription.updatePaymentMethodUrl;
    if (!url) throw new Error(page === "cancel" ? "no cancel page available" : "no payment page available");
    await shell.openExternal(url);
  }

  /** Open Paddle checkout for the chosen plan in the system browser, then poll until the webhook marks the sub active. */
  async subscribe(priceId: string): Promise<void> {
    if (this.status.active) return;
    const idToken = await this.getIdToken();
    if (!idToken) throw new Error("sign in first");
    let url: string;
    try {
      const res = await fetchJson(`${this.baseUrl}/checkout-session`, {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ priceId }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok || typeof body !== "object" || body === null || typeof (body as Record<string, unknown>).url !== "string") {
        const msg = typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).message === "string" ? String((body as Record<string, unknown>).message) : `http ${res.status}`;
        throw new Error(`couldn't start checkout: ${msg}`);
      }
      url = (body as { url: string }).url;
    } catch (e) {
      this.setStatus({ ...this.status, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    await shell.openExternal(url);
    void this.pollUntilActive();
  }

  /** The `coldstorage://checkout-complete` nudge — check right now instead of waiting for the next poll. */
  notifyCheckoutComplete(): void {
    void this.refresh();
  }

  dispose(): void {
    this.polling = false;
    this.listeners.clear();
  }

  private async pollUntilActive(): Promise<void> {
    if (this.polling) return; // one poll at a time
    this.polling = true;
    this.setStatus({ ...this.status, checkingOut: true, error: null });
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (this.polling && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (!this.polling) break;
      await this.refresh();
      if (this.status.active) break;
    }
    this.polling = false;
    this.setStatus({ ...this.status, checkingOut: false });
  }

  /* ── Paid retrieval (root RETRIEVAL.md) ───────────────────────────────────────────────────────────
   * Unlike the deposit gate above, this one is HARD: a signed-in daemon has no `s3:RestoreObject`, so a
   * frozen blob simply cannot be thawed except by the backend, and only for a restore that's paid for or
   * inside the free monthly allowance. So these aren't "checks" the UI could skip — they're the only way
   * the data comes back. */

  /**
   * Price a restore. Small ones come back `authorized` with `quoteCents: 0` — inside the free monthly
   * allowance, already thawing, nothing to pay and nothing to confirm.
   *
   * The bytes are quoted by the BACKEND, from the blobs' real sizes in S3 — never from anything the
   * renderer computes. (A restore is billed on whole blob objects thawed plus bytes downloaded; the
   * renderer can't know the first and shouldn't guess at the second.)
   */
  async quoteRestore(blobKeys: string[], egressBytes: number): Promise<RetrievalQuote> {
    const { res, body } = await this.authedJson<RetrievalQuote & { message?: string }>("/retrieval/quote", {
      method: "POST",
      body: JSON.stringify({ blobKeys, egressBytes }),
    });
    if (!res.ok) throw new Error(body?.message ?? `couldn't price this restore: http ${res.status}`);
    return body;
  }

  /**
   * Pay for a quoted restore, then wait for the money to land.
   *
   * Two paths, and the user only notices one of them: a subscriber's saved card is charged in place (no
   * browser, no checkout — they confirmed the price already), while someone with no card on file gets the
   * hosted Paddle checkout in their browser. Either way we then POLL until the webhook flips the job to
   * `paid` — the webhook is the source of truth, exactly as with subscription checkout above. The backend
   * thaws at that moment; the daemon can't do it, so nothing before that point makes the data reachable.
   */
  async payForRestore(jobId: string): Promise<RetrievalQuote> {
    const { res, body } = await this.authedJson<{ charged?: boolean; url?: string | null; message?: string }>(
      `/retrieval/jobs/${jobId}/pay`,
      { method: "POST" },
    );
    if (!res.ok) throw new Error(body?.message ?? `couldn't take the payment: http ${res.status}`);
    if (body?.url) await shell.openExternal(body.url);

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const job = await this.getRestoreJob(jobId);
      if (job.authorized) return job;
      if (job.status === "canceled") throw new Error("this restore was canceled");
    }
    // Not a failure of the payment — just of our patience. The job stays quoted and payable, and a
    // completed checkout will still flip it; say so rather than implying the money vanished.
    throw new Error("still waiting on the payment to clear — it may complete shortly; check back in a moment");
  }

  /** Poll one restore job (status + whether the backend has thawed its blobs yet). */
  async getRestoreJob(jobId: string): Promise<RetrievalQuote> {
    const { res, body } = await this.authedJson<RetrievalQuote & { message?: string }>(`/retrieval/jobs/${jobId}`);
    if (!res.ok) throw new Error(body?.message ?? `couldn't check this restore: http ${res.status}`);
    return body;
  }

  /** Drop a quote the user walked away from, so it burns none of their free allowance. */
  async cancelRestore(jobId: string): Promise<void> {
    await this.authedJson(`/retrieval/jobs/${jobId}/cancel`, { method: "POST" }).catch(() => undefined);
  }

  private setStatus(s: EntitlementStatus): void {
    this.status = s;
    for (const l of this.listeners) l(s);
  }
}
