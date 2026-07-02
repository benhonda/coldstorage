/**
 * Per-device MasterKey escrow (PROD.md Phase 5b). The MK is cached here, safeStorage-encrypted
 * (Keychain-backed on macOS), keyed by the Cognito user-pool `sub` so multiple accounts on one machine
 * never collide — so day-to-day launches unlock the vault with no recovery-code prompt. This is the
 * "per-device escrow" the key hierarchy relies on; the recovery code stays the only way onto a NEW
 * device (one with no entry here).
 *
 * Same posture as the refresh-token store: if the Keychain-backed encryptor is unavailable we persist
 * NOTHING (the vault just re-prompts next launch) — never plaintext key material on disk.
 */
import { readFile, writeFile } from "node:fs/promises";
import { safeStorage } from "electron";

/** On-disk shape: sub → base64(safeStorage-encrypted base64-MK). */
type VaultFile = Record<string, string>;

export class VaultStore {
  constructor(private readonly file: string) {}

  private async read(): Promise<VaultFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
      return typeof parsed === "object" && parsed !== null ? (parsed as VaultFile) : {};
    } catch {
      return {};
    }
  }

  /** The cached MasterKey (base64) for this account, or null if this device has never unlocked it. */
  async getMasterKey(sub: string): Promise<string | null> {
    const entry = (await this.read())[sub];
    if (typeof entry !== "string") return null;
    try {
      const { result } = await safeStorage.decryptStringAsync(Buffer.from(entry, "base64"));
      return result;
    } catch {
      // A signing-identity change (dev vs packaged) can orphan the ciphertext — treat as "not cached".
      return null;
    }
  }

  /** Escrow the MasterKey (base64) for this account. No-op (with a log) if encryption is unavailable. */
  async setMasterKey(sub: string, masterKeyB64: string): Promise<void> {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      console.error("safeStorage unavailable — the vault will re-prompt for the recovery code next launch");
      return;
    }
    const encrypted = await safeStorage.encryptStringAsync(masterKeyB64);
    const all = await this.read();
    all[sub] = encrypted.toString("base64");
    await writeFile(this.file, `${JSON.stringify(all)}\n`, { mode: 0o600 });
  }
}
