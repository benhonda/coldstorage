/**
 * Subscription entitlement — the billing half of being able to back up. Fetches
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
  /** Bumped whenever a poll is superseded or abandoned, so a stale loop can tell it no longer owns the status. */
  private pollEpoch = 0;
  /** The in-flight restore payment's checkout URL, and the same epoch trick for abandoning its wait. */
  private restoreCheckoutUrl: string | null = null;
  private restorePayEpoch = 0;
  /** The hosted-checkout URL of the in-flight checkout — so "reopen" costs no round trip and no new transaction. */
  private checkoutUrl: string | null = null;
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
    this.pollEpoch += 1;
    this.restorePayEpoch += 1;
    this.checkoutUrl = null;
    this.restoreCheckoutUrl = null;
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
    this.checkoutUrl = url;
    await shell.openExternal(url);
    void this.pollUntilActive();
  }

  /**
   * Reopen the checkout page the user already has open (or closed, or lost behind another window).
   * Same Paddle transaction — reopening must not create a second one.
   */
  async reopenCheckout(): Promise<void> {
    if (!this.checkoutUrl) throw new Error("no checkout is open");
    await shell.openExternal(this.checkoutUrl);
  }

  /**
   * "I'm not doing this right now." Stops the poll and drops the waiting state immediately, so the UI
   * goes straight back to the picker instead of sitting on a dead-end message until the poll times out.
   * Harmless if the checkout later completes anyway — the webhook is the source of truth and the next
   * refresh picks it up.
   */
  cancelCheckout(): void {
    this.polling = false;
    this.pollEpoch += 1;
    this.checkoutUrl = null;
    this.setStatus({ ...this.status, checkingOut: false, error: null });
  }

  /** The `coldstorage://checkout-complete` nudge — check right now instead of waiting for the next poll. */
  notifyCheckoutComplete(): void {
    void this.refresh();
  }

  dispose(): void {
    this.polling = false;
    this.pollEpoch += 1;
    this.restorePayEpoch += 1;
    this.listeners.clear();
  }

  private async pollUntilActive(): Promise<void> {
    if (this.polling) return; // one poll at a time
    this.polling = true;
    const epoch = ++this.pollEpoch;
    this.setStatus({ ...this.status, checkingOut: true, error: null });
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (this.pollEpoch === epoch && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (this.pollEpoch !== epoch) break;
      await this.refresh();
      if (this.status.active) break;
    }
    // Abandoned or superseded mid-sleep: whoever bumped the epoch owns the status now — don't write over it.
    if (this.pollEpoch !== epoch) return;
    // Otherwise we timed out with nothing to show for it: say so rather than silently dropping back to the picker.
    this.polling = false;
    this.setStatus({
      ...this.status,
      checkingOut: false,
      error: this.status.active ? null : "We never saw that checkout finish. If you did pay, give it a minute — it'll turn on by itself.",
    });
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
   * Charge for a quoted restore. Two paths, and the caller has to know which one it got: a subscriber's
   * saved card is charged in place (no browser — they confirmed the price already), while someone with no
   * card on file gets the hosted Paddle checkout in their browser. That's what `checkoutOpened` reports,
   * and it's why paying is split from waiting: a wait with a browser tab behind it needs a "reopen it"
   * button, and a wait without one must not offer a button that opens nothing.
   *
   * Either way the money isn't real until the webhook says so — call {@link awaitRestorePayment} next.
   */
  async startRestorePayment(jobId: string): Promise<{ checkoutOpened: boolean }> {
    const { res, body } = await this.authedJson<{ charged?: boolean; url?: string | null; message?: string }>(
      `/retrieval/jobs/${jobId}/pay`,
      { method: "POST" },
    );
    if (!res.ok) throw new Error(body?.message ?? `couldn't take the payment: http ${res.status}`);
    this.restoreCheckoutUrl = body?.url ?? null;
    if (this.restoreCheckoutUrl) await shell.openExternal(this.restoreCheckoutUrl);
    return { checkoutOpened: this.restoreCheckoutUrl !== null };
  }

  /**
   * Wait for a started restore payment to clear. POLLS until the webhook flips the job authorized — the
   * webhook is the source of truth, exactly as with subscription checkout above. The backend thaws at that
   * moment; the daemon can't do it, so nothing before this resolves makes the data reachable.
   *
   * Resolves `null` when the user walked away via {@link cancelRestorePayment} — an abandoned wait is not
   * an error, and the caller must not report one.
   */
  async awaitRestorePayment(jobId: string): Promise<RetrievalQuote | null> {
    const epoch = ++this.restorePayEpoch;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (this.restorePayEpoch !== epoch) return null; // abandoned mid-sleep
      const job = await this.getRestoreJob(jobId);
      if (this.restorePayEpoch !== epoch) return null;
      if (job.authorized) return job;
      if (job.status === "canceled") throw new Error("this restore was canceled");
    }
    // Not a failure of the payment — just of our patience. The job stays quoted and payable, and a
    // completed checkout will still flip it; say so rather than implying the money vanished.
    throw new Error("still waiting on the payment to clear — it may complete shortly; check back in a moment");
  }

  /** Reopen the restore's checkout page — the tab they closed or lost. Same Paddle transaction. */
  async reopenRestoreCheckout(): Promise<void> {
    if (!this.restoreCheckoutUrl) throw new Error("no checkout is open");
    await shell.openExternal(this.restoreCheckoutUrl);
  }

  /**
   * "Never mind" on a restore payment: stop waiting, and hand the quote back so it burns none of the free
   * monthly allowance ({@link abandonQuote}). The in-flight {@link awaitRestorePayment} resolves `null`.
   */
  async cancelRestorePayment(jobId: string): Promise<void> {
    this.restorePayEpoch += 1;
    this.restoreCheckoutUrl = null;
    await this.abandonQuote(jobId);
  }

  /** Poll one restore job (status + whether the backend has thawed its blobs yet). */
  async getRestoreJob(jobId: string): Promise<RetrievalQuote> {
    const { res, body } = await this.authedJson<RetrievalQuote & { message?: string }>(`/retrieval/jobs/${jobId}`);
    if (!res.ok) throw new Error(body?.message ?? `couldn't check this restore: http ${res.status}`);
    return body;
  }

  /** Drop a QUOTE the user walked away from, so it burns none of their free allowance. Distinct from the
   * daemon's `cancelRestore`, which stops an in-flight transfer — see `ColdstoreApi.abandonQuote`. */
  async abandonQuote(jobId: string): Promise<void> {
    await this.authedJson(`/retrieval/jobs/${jobId}/cancel`, { method: "POST" }).catch(() => undefined);
  }

  private setStatus(s: EntitlementStatus): void {
    this.status = s;
    for (const l of this.listeners) l(s);
  }
}
