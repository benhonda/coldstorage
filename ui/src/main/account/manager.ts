/**
 * The account profile + onboarding facts (backend `/account`) — the state the first-run wizard's
 * resume rules derive from (ui/DESIGN.md §onboarding). Same shape as {@link EntitlementManager}:
 * fetch on every fresh ID token, push status to the renderer, reset on sign-out.
 *
 * Terms are sign-in-wrap ("By continuing, you agree…" on the sign-in card): continuing past that
 * line IS the agreement, so `refresh` records it — quietly PATCHing `acceptTerms` whenever the
 * stored version differs from the backend's current one. No screen; the versioned columns exist so
 * a MATERIAL terms change can add a re-agree gate later without new machinery.
 */
import type { AccountStatus, SurveyAnswers } from "../../shared/ipc.ts";

/** Mirrors backend `survey.ts` SURVEY_VERSION — bump together (the backend rejects a mismatch). */
const SURVEY_VERSION = 1;

const REQUEST_TIMEOUT_MS = 15_000;

const fetchJson = async (url: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    throw new Error(
      e instanceof DOMException && e.name === "TimeoutError"
        ? "the account server didn't respond in time"
        : "couldn't reach the account server",
    );
  }
};

const signedOut: AccountStatus = { known: false, displayName: null, onboarded: false, recoveryCodeConfirmed: false, error: null };

export class AccountManager {
  private status: AccountStatus = signedOut;
  private readonly listeners = new Set<(s: AccountStatus) => void>();

  constructor(
    private readonly baseUrl: string,
    private readonly getIdToken: () => Promise<string | null>,
  ) {}

  accountStatus(): AccountStatus {
    return this.status;
  }

  onStatus(listener: (s: AccountStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-read the account from the backend (every fresh ID token). No-op (silent) when signed out. */
  async refresh(): Promise<void> {
    const idToken = await this.getIdToken();
    if (!idToken) {
      this.setStatus(signedOut);
      return;
    }
    try {
      const res = await fetchJson(`${this.baseUrl}/account`, { headers: { Authorization: `Bearer ${idToken}` } });
      if (!res.ok) throw new Error(`account check failed: http ${res.status}`);
      const body: unknown = await res.json().catch(() => null);
      const r = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      this.setStatus({
        known: true,
        displayName: typeof r.displayName === "string" ? r.displayName : null,
        onboarded: r.onboardedAt != null,
        recoveryCodeConfirmed: r.recoveryCodeConfirmedAt != null,
        error: null,
      });
      // Sign-in-wrap: the user continued past the agreement line to be here — record it against the
      // CURRENT version if the stored one is absent/stale. Quiet + best-effort (retries next token).
      if (r.termsVersion !== r.currentTermsVersion) {
        void this.patch({ acceptTerms: true }).catch((e: unknown) => console.error("terms acceptance PATCH failed:", e));
      }
    } catch (e) {
      // The wizard FAILS OPEN on `known: false` (never blocks the vault on account-server trouble) —
      // keep whatever we knew, surface the error for visibility.
      this.setStatus({ ...this.status, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Reset to signed-out (called on sign-out) so a next user doesn't inherit this one's profile. */
  reset(): void {
    this.setStatus(signedOut);
  }

  /** Set the display name (wizard step 1 + the Settings edit). Optimistically reflected in status. */
  async setDisplayName(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("enter a name first");
    await this.patch({ displayName: trimmed.slice(0, 64) });
    this.setStatus({ ...this.status, displayName: trimmed.slice(0, 64) });
  }

  /** Record the survey answers (skipped questions absent). Versioned for the backend's validation. */
  async submitSurvey(answers: SurveyAnswers): Promise<void> {
    await this.patch({ survey: { v: SURVEY_VERSION, ...answers } });
  }

  /** The wizard finished — the fact that stops it ever re-running for this account. */
  async completeOnboarding(): Promise<void> {
    await this.patch({ onboarded: true });
    this.setStatus({ ...this.status, onboarded: true });
  }

  /** The user ticked "I've saved my recovery code". */
  async confirmRecoveryCode(): Promise<void> {
    await this.patch({ recoveryCodeConfirmed: true });
    this.setStatus({ ...this.status, recoveryCodeConfirmed: true });
  }

  dispose(): void {
    this.listeners.clear();
  }

  private async patch(body: Record<string, unknown>): Promise<void> {
    const idToken = await this.getIdToken();
    if (!idToken) throw new Error("sign in first");
    const res = await fetchJson(`${this.baseUrl}/account`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`account update failed: http ${res.status}`);
  }

  private setStatus(s: AccountStatus): void {
    this.status = s;
    for (const l of this.listeners) l(s);
  }
}
