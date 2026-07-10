/**
 * Subscription entitlement (PROD.md Phase 5c) — the billing half of being able to back up. Fetches
 * `GET /entitlement` (is the sub active?) and drives checkout: `POST /checkout-session` creates the
 * Paddle transaction server-side (carrying `cognitoSub`), we open its hosted-checkout URL in the system
 * browser, and then POLL `/entitlement` until the webhook flips it active — the webhook is the source of
 * truth, the browser round-trip is not. A `coldstorage://checkout-complete` deep link, if it arrives,
 * is just a "check now" nudge into the same poll.
 *
 * This is a SOFT gate: it blocks the app from starting a deposit, not S3 at the IAM layer (see the
 * backend entitlement route). Browse/restore stay available unsubscribed — you can always get data back.
 */
import { shell } from "electron";
import type { CatalogPlan, EntitlementStatus } from "../../shared/ipc.ts";

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
  private status: EntitlementStatus = { known: false, active: false, checkingOut: false, error: null };
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
      this.setStatus({ known: false, active: false, checkingOut: false, error: null });
      return;
    }
    try {
      const res = await fetchJson(`${this.baseUrl}/entitlement`, { headers: { Authorization: `Bearer ${idToken}` } });
      if (!res.ok) throw new Error(`entitlement check failed: http ${res.status}`);
      const body: unknown = await res.json().catch(() => null);
      const active = typeof body === "object" && body !== null && (body as Record<string, unknown>).active === true;
      this.setStatus({ ...this.status, known: true, active, error: null });
    } catch (e) {
      this.setStatus({ ...this.status, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Reset to signed-out (called on sign-out) so a next user doesn't inherit this one's entitlement. */
  reset(): void {
    this.polling = false;
    this.setStatus({ known: false, active: false, checkingOut: false, error: null });
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

  private setStatus(s: EntitlementStatus): void {
    this.status = s;
    for (const l of this.listeners) l(s);
  }
}
