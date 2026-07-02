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

/** Fail LOUD, not hang: Node's fetch has no default timeout, so a slow/stuck backend would leave the
 * app on "Setting up…" forever. Bound every call so a hang becomes a visible, retryable error. */
const REQUEST_TIMEOUT_MS = 15_000;

/** fetch with a timeout + a message that names the cause (timeout vs transport) instead of a bare abort. */
const fetchWithTimeout = async (url: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error(`account backend didn't respond within ${REQUEST_TIMEOUT_MS / 1000}s (${url})`);
    }
    throw new Error(`couldn't reach the account backend: ${e instanceof Error ? e.message : String(e)}`);
  }
};

export class KeyBlobClient {
  constructor(private readonly baseUrl: string) {}

  /** GET the caller's key-blob, or null if the account has none yet (404 — a new account to mint for).
   * The Cognito ID token authenticates (the backend verifies it via JWKS). */
  async get(idToken: string): Promise<KeyBlobFields | null> {
    const res = await fetchWithTimeout(`${this.baseUrl}/key-blob`, { headers: { Authorization: `Bearer ${idToken}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`key-blob GET failed: http ${res.status}`);
    const body: unknown = await res.json().catch(() => null);
    if (!isBackendKeyBlob(body)) throw new Error("key-blob GET returned an unexpected shape (is the backend URL right?)");
    return fromBackend(body);
  }

  /** PUT (upsert) the caller's key-blob — blind ciphertext storage. */
  async put(idToken: string, blob: KeyBlobFields): Promise<void> {
    const res = await fetchWithTimeout(`${this.baseUrl}/key-blob`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(toBackend(blob)),
    });
    if (!res.ok) throw new Error(`key-blob PUT failed: http ${res.status}`);
  }
}
