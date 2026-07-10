/** The dev loopback listener — real sockets on the real port (node:http, no Electron). */
import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { awaitLoopbackCallback, LOOPBACK_PORT, LOOPBACK_REDIRECT_URI } from "./loopback.ts";

describe("awaitLoopbackCallback", () => {
  test("serves the one callback, hands the full URL over, and closes", async () => {
    let got: string | null = null;
    const { ready } = awaitLoopbackCallback((url) => (got = url));
    await ready;

    // A non-callback probe (what ui:mac:auth:doctor sends) 404s WITHOUT consuming the listener.
    const probe = await fetch(`http://127.0.0.1:${LOOPBACK_PORT}/ping`);
    expect(probe.status).toBe(404);
    expect(got).toBeNull();

    const res = await fetch(`${LOOPBACK_REDIRECT_URI}?code=abc&state=xyz`);
    expect(res.status).toBe(200);
    expect(got).not.toBeNull();
    const url = new URL(got as unknown as string);
    expect(url.searchParams.get("code")).toBe("abc");
    expect(url.searchParams.get("state")).toBe("xyz");
  });

  test("ready rejects when the port is already taken (the VS Code port-forward failure mode)", async () => {
    const squatter = createServer(() => {});
    await new Promise<void>((resolve) => squatter.listen(LOOPBACK_PORT, "127.0.0.1", resolve));
    try {
      const { ready, stop } = awaitLoopbackCallback(() => {});
      // Node says "EADDRINUSE", Bun's node:http shim says "Is port … in use?" — assert the shared idea.
      await expect(ready).rejects.toThrow(/EADDRINUSE|in use/i);
      stop();
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });
});
