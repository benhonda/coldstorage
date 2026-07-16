/** VaultManager provisioning branches — headless, with fakes for the daemon client / key-blob / store. */
import { describe, expect, test } from "bun:test";
import { VaultManager } from "./manager.ts";
import type { DaemonClient } from "../../daemon/client.ts";
import type { KeyBlobFields } from "../../daemon/protocol.ts";
import type { VaultStatus } from "../../shared/ipc.ts";
import type { KeyBlobClient } from "./keyblob-client.ts";
import type { VaultStore } from "./storage.ts";

/** A JWT (unsigned — we only decode the payload) carrying a `sub`. */
const tokenFor = (sub: string): string => {
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
};

const BLOB: KeyBlobFields = {
  wrappedMKPassword: "cA==",
  saltPassword: "cw==",
  wrappedMKRecovery: "cg==",
  saltRecovery: "cw==",
  opsLimit: 3,
  memLimit: 65536,
};

/** Records daemon commands and returns per-method canned results. */
const makeClient = (results: Record<string, unknown>, calls: Array<[string, unknown]>): DaemonClient =>
  ({
    request: (method: string, params?: unknown) => {
      calls.push([method, params]);
      return Promise.resolve(results[method]);
    },
  }) as unknown as DaemonClient;

const makeStore = (initial: Record<string, string> = {}): VaultStore & { saved: Record<string, string> } => {
  const saved: Record<string, string> = { ...initial };
  return {
    saved,
    getMasterKey: (sub: string) => Promise.resolve(saved[sub] ?? null),
    setMasterKey: (sub: string, mk: string) => {
      saved[sub] = mk;
      return Promise.resolve();
    },
  } as unknown as VaultStore & { saved: Record<string, string> };
};

const makeKeyBlob = (getResult: KeyBlobFields | null, puts: KeyBlobFields[]): KeyBlobClient =>
  ({
    get: () => Promise.resolve(getResult),
    put: (_idToken: string, blob: KeyBlobFields) => {
      puts.push(blob);
      return Promise.resolve();
    },
  }) as unknown as KeyBlobClient;

const track = (vault: VaultManager): { last: () => VaultStatus } => {
  let last = vault.vaultStatus();
  vault.onStatus((s) => (last = s));
  return { last: () => last };
};

describe("VaultManager.provision", () => {
  test("cached MK on this device → silent unlockVault, no backend call", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = makeClient({ unlockVault: { ok: true } }, calls);
    const puts: KeyBlobFields[] = [];
    const vault = new VaultManager(client, makeStore({ "user-1": "CACHEDMK" }), makeKeyBlob(null, puts));
    const t = track(vault);

    await vault.provision(tokenFor("user-1"));

    expect(calls).toEqual([["unlockVault", { masterKey: "CACHEDMK" }]]);
    expect(puts).toHaveLength(0);
    expect(t.last().state).toBe("unlocked");
  });

  test("no cache + no key-blob (new account) → mint, PUT the blob, escrow the MK, show the code once", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = makeClient(
      { mintVault: { ok: true, ...BLOB, recoveryCode: "AB3DE-FG4HJ-KM5NP-QR6ST-VW7XZ", masterKey: "MINTEDMK" } },
      calls,
    );
    const puts: KeyBlobFields[] = [];
    const store = makeStore();
    const vault = new VaultManager(client, store, makeKeyBlob(null, puts));
    const t = track(vault);

    await vault.provision(tokenFor("user-1"));

    expect(calls.map((c) => c[0])).toEqual(["mintVault"]);
    expect(puts).toHaveLength(1); // the blob was stored server-side
    expect(store.saved["user-1"]).toBe("MINTEDMK"); // and escrowed on this device
    expect(t.last().state).toBe("unlocked");
    expect(t.last().recoveryCode).toBe("AB3DE-FG4HJ-KM5NP-QR6ST-VW7XZ");

    vault.acknowledgeRecoveryCode();
    expect(t.last().recoveryCode).toBeNull();
  });

  test("no cache + existing key-blob (new device) → needsRecoveryCode, then unlock on submit", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = makeClient(
      { unlockVaultWithRecoveryCode: { ok: true, masterKey: "UNLOCKEDMK" } },
      calls,
    );
    const store = makeStore();
    const vault = new VaultManager(client, store, makeKeyBlob(BLOB, []));
    const t = track(vault);

    await vault.provision(tokenFor("user-1"));
    expect(t.last().state).toBe("needsRecoveryCode");
    expect(calls).toHaveLength(0); // nothing minted/unlocked yet

    await vault.submitRecoveryCode("  ab3de-fg4hj  "); // trimmed
    expect(calls[0]?.[0]).toBe("unlockVaultWithRecoveryCode");
    const params = calls[0]?.[1] as { recoveryCode: string; opsLimit: unknown; memLimit: unknown };
    expect(params.recoveryCode).toBe("ab3de-fg4hj");
    // The control wire is [String:String] — numeric key-blob params MUST be strings or the daemon's
    // param decode fails (looks like a wrong code). Guard against a regression.
    expect(params.opsLimit).toBe("3");
    expect(params.memLimit).toBe("65536");
    expect(store.saved["user-1"]).toBe("UNLOCKEDMK");
    expect(t.last().state).toBe("unlocked");
  });

  test("backend failure surfaces as an error status (retryable), not a throw", async () => {
    const store = makeStore();
    const failing = { get: () => Promise.reject(new Error("network down")) } as unknown as KeyBlobClient;
    const vault = new VaultManager(makeClient({}, []), store, failing);
    const t = track(vault);

    await vault.provision(tokenFor("user-1"));
    expect(t.last().state).toBe("error");
    expect(t.last().error).toContain("network down");
  });

  test("relock tells the daemon to lock and resets status", async () => {
    const calls: Array<[string, unknown]> = [];
    const vault = new VaultManager(makeClient({ lockVault: { ok: true } }, calls), makeStore(), makeKeyBlob(null, []));
    const t = track(vault);

    await vault.relock();
    expect(calls).toEqual([["lockVault", undefined]]);
    expect(t.last().state).toBe("locked");
  });
});

describe("VaultManager.reissueRecoveryCode", () => {
  const MINTED = {
    ok: true,
    ...BLOB,
    recoveryCode: "ZX7WV-TS6RQ-PN5MK-JH4GF-ED3BA",
    masterKey: "SAMEMK",
  };

  test("PUTs the fresh blob server-side BEFORE showing the code", async () => {
    const calls: Array<[string, unknown]> = [];
    const puts: KeyBlobFields[] = [];
    const vault = new VaultManager(
      makeClient({ reissueRecoveryCode: MINTED }, calls),
      makeStore(),
      makeKeyBlob(BLOB, puts),
      () => Promise.resolve("idtok"),
    );
    const t = track(vault);

    await vault.reissueRecoveryCode();
    expect(calls).toEqual([["reissueRecoveryCode", undefined]]);
    expect(puts).toHaveLength(1); // the server copy was replaced…
    expect(t.last().recoveryCode).toBe("ZX7WV-TS6RQ-PN5MK-JH4GF-ED3BA"); // …and only then is the code shown
  });

  test("a failed PUT shows NO code (the old one must stay valid)", async () => {
    const failing = {
      get: () => Promise.resolve(BLOB),
      put: () => Promise.reject(new Error("network down")),
    } as unknown as KeyBlobClient;
    const vault = new VaultManager(makeClient({ reissueRecoveryCode: MINTED }, []), makeStore(), failing, () => Promise.resolve("idtok"));
    const t = track(vault);

    await expect(vault.reissueRecoveryCode()).rejects.toThrow(/network down/);
    expect(t.last().recoveryCode).toBeNull();
  });

  test("signed out → rejects without touching the daemon", async () => {
    const calls: Array<[string, unknown]> = [];
    const vault = new VaultManager(makeClient({}, calls), makeStore(), makeKeyBlob(null, []));
    await expect(vault.reissueRecoveryCode()).rejects.toThrow(/sign in/);
    expect(calls).toHaveLength(0);
  });
});
