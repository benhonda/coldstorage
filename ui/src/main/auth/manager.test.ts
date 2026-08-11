/**
 * AuthManager's pending-sign-in lifecycle — the ways an in-flight browser attempt ENDS other than
 * success, which is where the "stuck on 'finish signing in in your browser'" bug lived. Real manager
 * code with electron stubbed (the entitlement-manager pattern); `useLoopback: false` exercises the
 * packaged deep-link path, so nothing binds a port.
 */
import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import type { AuthStatus } from "../../shared/ipc.ts";

// signIn() opens the browser; restore() reads userData/auth.json (absent here → a normal signed-out start).
const opened: string[] = [];
mock.module("electron", () => ({
  app: { getPath: () => "/nonexistent-userdata" },
  safeStorage: { isAsyncEncryptionAvailable: () => Promise.resolve(false) },
  shell: { openExternal: (u: string) => (opened.push(u), Promise.resolve()) },
}));

const { AuthManager } = await import("./manager.ts");

const CFG = {
  domain: "auth.test.amazoncognito.com",
  clientId: "client123",
  redirectUri: "coldstorage://auth/callback",
  region: "ca-central-1",
};

/** A settled (restore-complete) manager plus the statuses it pushed. */
const makeManager = async (): Promise<{ auth: InstanceType<typeof AuthManager>; pushes: AuthStatus[] }> => {
  const auth = new AuthManager(CFG, { useLoopback: false });
  const pushes: AuthStatus[] = [];
  auth.onStatus((s) => pushes.push(s));
  await auth.restore();
  pushes.length = 0;
  return { auth, pushes };
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  opened.length = 0;
});

describe("AuthManager pending sign-in", () => {
  test("signIn opens the browser and reports signingIn", async () => {
    const { auth, pushes } = await makeManager();
    await auth.signIn();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("identity_provider=Google");
    expect(auth.status()).toMatchObject({ state: "signingIn", error: null });
    expect(pushes.at(-1)?.state).toBe("signingIn");
    auth.dispose();
  });

  test("cancelSignIn returns to signedOut so another lane can be picked", async () => {
    const { auth, pushes } = await makeManager();
    await auth.signIn();
    auth.cancelSignIn();
    expect(auth.status()).toMatchObject({ state: "signedOut", error: null });
    expect(pushes.at(-1)?.state).toBe("signedOut");
    auth.dispose();
  });

  test("cancelSignIn with nothing in flight is a no-op (no spurious push)", async () => {
    const { auth, pushes } = await makeManager();
    auth.cancelSignIn();
    expect(pushes).toHaveLength(0);
    expect(auth.status().state).toBe("signedOut");
    auth.dispose();
  });

  test("a callback that never comes expires on its own, with a reason", async () => {
    const { auth } = await makeManager();
    await auth.signIn();
    jest.advanceTimersByTime(5 * 60 * 1000 + 1);
    const s = auth.status();
    expect(s.state).toBe("signedOut");
    expect(s.error).toContain("timed out");
    auth.dispose();
  });

  test("a cancelled attempt stops expiring — no late error lands on a fresh screen", async () => {
    const { auth } = await makeManager();
    await auth.signIn();
    auth.cancelSignIn();
    jest.advanceTimersByTime(10 * 60 * 1000);
    expect(auth.status()).toMatchObject({ state: "signedOut", error: null });
    auth.dispose();
  });

  test("a superseding signIn replaces the old attempt's expiry rather than adding one", async () => {
    const { auth } = await makeManager();
    await auth.signIn();
    jest.advanceTimersByTime(4 * 60 * 1000);
    await auth.signIn(); // "Open the browser again" — the restart re-arms the full TTL
    jest.advanceTimersByTime(2 * 60 * 1000);
    expect(auth.status().state).toBe("signingIn");
    jest.advanceTimersByTime(3 * 60 * 1000 + 1);
    expect(auth.status().state).toBe("signedOut");
    auth.dispose();
  });

  test("the user cancelling at Google unwinds without an error message", async () => {
    const { auth } = await makeManager();
    await auth.signIn();
    const state = new URL(opened[0]).searchParams.get("state");
    expect(await auth.handleCallbackUrl(`coldstorage://auth/callback?error=access_denied&state=${state}`)).toBe(true);
    expect(auth.status()).toMatchObject({ state: "signedOut", error: null });
    auth.dispose();
  });

  test("a callback for a foreign state leaves our attempt alone (CSRF/duplicate guard)", async () => {
    const { auth } = await makeManager();
    await auth.signIn();
    await auth.handleCallbackUrl("coldstorage://auth/callback?error=access_denied&state=not-ours");
    expect(auth.status().state).toBe("signingIn");
    auth.dispose();
  });
});
