/**
 * The account-backend key-blob HTTP client (PROD.md Phase 5b). Blind ciphertext in/out — this only
 * transports the KeyBlob the daemon minted; it never sees a MasterKey, password, or recovery code.
 *
 * Field-name seam: the daemon/`protocol.ts` use `wrappedMK…` (matching Swift's `KeyBlob`), the backend
 * schema uses `wrappedMk…` (camel). The two `Mk`/`MK` keys are mapped here, at the one boundary that
 * talks to the backend, so neither side has to know about the other's casing.
 */
import type { KeyBlobFields } from "../../daemon/protocol.ts";

/** The backend's on-the-wire shape (see account-backend `keyBlobSchema`). */
interface BackendKeyBlob {
  wrappedMkPassword: string;
  saltPassword: string;
  wrappedMkRecovery: string;
  saltRecovery: string;
  opsLimit: number;
  memLimit: number;
}

const toBackend = (b: KeyBlobFields): BackendKeyBlob => ({
  wrappedMkPassword: b.wrappedMKPassword,
  saltPassword: b.saltPassword,
  wrappedMkRecovery: b.wrappedMKRecovery,
  saltRecovery: b.saltRecovery,
  opsLimit: b.opsLimit,
  memLimit: b.memLimit,
});

const isBackendKeyBlob = (v: unknown): v is BackendKeyBlob => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.wrappedMkPassword === "string" &&
    typeof o.saltPassword === "string" &&
    typeof o.wrappedMkRecovery === "string" &&
    typeof o.saltRecovery === "string" &&
    typeof o.opsLimit === "number" &&
    typeof o.memLimit === "number"
  );
};

const fromBackend = (b: BackendKeyBlob): KeyBlobFields => ({
  wrappedMKPassword: b.wrappedMkPassword,
  saltPassword: b.saltPassword,
  wrappedMKRecovery: b.wrappedMkRecovery,
  saltRecovery: b.saltRecovery,
  opsLimit: b.opsLimit,
  memLimit: b.memLimit,
});

export class KeyBlobClient {
  constructor(private readonly baseUrl: string) {}

  /** GET the caller's key-blob, or null if the account has none yet (404 — a new account to mint for).
   * The Cognito ID token authenticates (the backend verifies it via JWKS). */
  async get(idToken: string): Promise<KeyBlobFields | null> {
    const res = await fetch(`${this.baseUrl}/key-blob`, { headers: { Authorization: `Bearer ${idToken}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`key-blob GET failed: http ${res.status}`);
    const body: unknown = await res.json().catch(() => null);
    if (!isBackendKeyBlob(body)) throw new Error("key-blob GET returned an unexpected shape");
    return fromBackend(body);
  }

  /** PUT (upsert) the caller's key-blob — blind ciphertext storage. */
  async put(idToken: string, blob: KeyBlobFields): Promise<void> {
    const res = await fetch(`${this.baseUrl}/key-blob`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(toBackend(blob)),
    });
    if (!res.ok) throw new Error(`key-blob PUT failed: http ${res.status}`);
  }
}
