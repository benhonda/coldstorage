/**
 * Main-process zero-knowledge vault orchestrator (PROD.md Phase 5b). Sits between sign-in (the ID token)
 * and the daemon's vault commands, and decides — per account, per device — how the daemon gets its
 * MasterKey:
 *
 *   cached MK on this device   → `unlockVault` (silent, day-to-day; the common path)
 *   no cache, no key-blob yet  → `mintVault` → store the blob server-side + show the recovery code once
 *   no cache, key-blob exists  → NEW device → prompt for the recovery code → `unlockVaultWithRecoveryCode`
 *
 * The MasterKey and recovery code cross only the local control socket + (the code) one IPC hop to be
 * shown once. The backend only ever sees blind ciphertext (the key-blob). This is the encryption half of
 * "signed in"; {@link AuthManager} is the AWS-credentials half — both must be live for a real deposit,
 * so the daemon handoff (index.ts) runs `authenticate` then this in sequence.
 */
import { decodeJwtClaims } from "../auth/oauth.ts";
import type { DaemonClient } from "../../daemon/client.ts";
import type { KeyBlobFields } from "../../daemon/protocol.ts";
import type { VaultStatus } from "../../shared/ipc.ts";
import type { KeyBlobClient } from "./keyblob-client.ts";
import type { VaultStore } from "./storage.ts";

export class VaultManager {
  private status: VaultStatus = { state: "locked", recoveryCode: null, error: null };
  /** The account whose vault we're currently managing (the ID token's `sub`). */
  private sub: string | null = null;
  /** Set while state is `needsRecoveryCode`: the blob fetched from the backend, awaiting the user's code. */
  private pendingBlob: KeyBlobFields | null = null;
  /** Coalesce concurrent provisions (a token refresh racing a daemon reconnect). */
  private provisioning: Promise<void> | null = null;
  private readonly listeners = new Set<(s: VaultStatus) => void>();

  constructor(
    private readonly client: DaemonClient,
    private readonly store: VaultStore,
    private readonly keyBlob: KeyBlobClient,
  ) {}

  vaultStatus(): VaultStatus {
    return this.status;
  }

  onStatus(listener: (s: VaultStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Provision the daemon's vault for the signed-in user. Called after `authenticate` succeeds (fresh
   * sign-in, hourly token refresh, and daemon reconnect). Idempotent: once a device has a cached MK,
   * every later call just re-sends `unlockVault` — which is exactly what a daemon reconnect needs.
   */
  async provision(idToken: string): Promise<void> {
    // Serialize: a refresh and a reconnect can both fire; the second awaits the first rather than racing
    // two mint/unlock sequences.
    const run = (this.provisioning ?? Promise.resolve()).then(() => this.provisionOnce(idToken));
    this.provisioning = run.catch(() => {});
    return run;
  }

  private async provisionOnce(idToken: string): Promise<void> {
    const sub = decodeJwtClaims(idToken)?.sub;
    if (typeof sub !== "string") {
      this.setStatus({ state: "error", recoveryCode: null, error: "signed-in token has no account id" });
      return;
    }
    this.sub = sub;
    try {
      // 1. This device already unlocked before → silent re-unlock from the Keychain cache.
      const cached = await this.store.getMasterKey(sub);
      if (cached) {
        await this.client.request("unlockVault", { masterKey: cached });
        this.setStatus({ state: "unlocked", recoveryCode: null, error: null });
        return;
      }

      // 2. Nothing cached — consult the backend. Keep any one-time recoveryCode already shown (a token
      //    refresh mid-acknowledge shouldn't blank it), but otherwise move to provisioning.
      if (this.status.state !== "unlocked") {
        this.setStatus({ state: "provisioning", recoveryCode: null, error: null });
      }
      const blob = await this.keyBlob.get(idToken);
      if (blob === null) {
        // New account → mint. The daemon loads the MK live and returns it + the one-time code.
        const minted = await this.client.request("mintVault");
        await this.keyBlob.put(idToken, minted);
        await this.store.setMasterKey(sub, minted.masterKey);
        this.setStatus({ state: "unlocked", recoveryCode: minted.recoveryCode, error: null });
      } else {
        // Existing account, new device → the user must enter their recovery code.
        this.pendingBlob = blob;
        this.setStatus({ state: "needsRecoveryCode", recoveryCode: null, error: null });
      }
    } catch (e) {
      this.setStatus({ state: "error", recoveryCode: null, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** New-device unlock: the user typed their recovery code. Throws (message surfaced to the UI) on a
   * wrong code so the entry screen can show it; on success the daemon is unlocked and the MK escrowed. */
  async submitRecoveryCode(code: string): Promise<void> {
    if (!this.sub || !this.pendingBlob) throw new Error("no vault is awaiting a recovery code");
    const b = this.pendingBlob;
    // opsLimit/memLimit go as strings — the control wire is [String:String] (see protocol.ts).
    const res = await this.client.request("unlockVaultWithRecoveryCode", {
      wrappedMKPassword: b.wrappedMKPassword,
      saltPassword: b.saltPassword,
      wrappedMKRecovery: b.wrappedMKRecovery,
      saltRecovery: b.saltRecovery,
      opsLimit: String(b.opsLimit),
      memLimit: String(b.memLimit),
      recoveryCode: code.trim(),
    });
    await this.store.setMasterKey(this.sub, res.masterKey);
    this.pendingBlob = null;
    this.setStatus({ state: "unlocked", recoveryCode: null, error: null });
  }

  /** Surface a failure from the step BEFORE vault provisioning (the daemon `authenticate` call in the
   * handoff) so the UI shows a real error instead of an eternal "Setting up…". Ignored once the vault is
   * already unlocked (a later transient blip shouldn't blank a working session). */
  markProvisionError(message: string): void {
    if (this.status.state === "unlocked") return;
    this.setStatus({ state: "error", recoveryCode: null, error: message });
  }

  /** The user acknowledged saving their one-time recovery code — clear it from the status. */
  acknowledgeRecoveryCode(): void {
    if (this.status.recoveryCode) this.setStatus({ ...this.status, recoveryCode: null });
  }

  /** Sign-out: tell the daemon to drop the MasterKey. The per-device Keychain escrow is deliberately
   * KEPT (signing out of the account ≠ un-trusting the device), so re-signing in unlocks silently; a
   * full reset (`task daemon:mac:reset:local`) is what wipes the escrow. */
  async relock(): Promise<void> {
    this.sub = null;
    this.pendingBlob = null;
    this.provisioning = null;
    this.setStatus({ state: "locked", recoveryCode: null, error: null });
    try {
      await this.client.request("lockVault");
    } catch (e) {
      console.error("lockVault failed (daemon may be down; it drops the key on exit anyway):", e);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }

  private setStatus(s: VaultStatus): void {
    this.status = s;
    for (const l of this.listeners) l(s);
  }
}
