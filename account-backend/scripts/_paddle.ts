/**
 * Shared helper for the one-off Paddle ops scripts (seed-paddle-catalog, create-paddle-client-token).
 * Every script targets an EXPLICIT environment via `--env sandbox|production` — with both keys
 * resident in the shell (PADDLE_API_KEY = live, PADDLE_API_KEY_FOR_SANDBOX = sandbox) the flag,
 * not whichever key happens to be exported, decides where a run lands. The key prefix
 * (pdl_live_… / pdl_sdbx_…) is then ASSERTED against the chosen environment, so a key pasted
 * into the wrong var fails loudly instead of silently crossing environments.
 */
import { Paddle, Environment } from "@paddle/paddle-node-sdk";

type PaddleEnv = "sandbox" | "production";

const KEY_VAR: Record<PaddleEnv, string> = {
  production: "PADDLE_API_KEY",
  sandbox: "PADDLE_API_KEY_FOR_SANDBOX",
};
const KEY_PREFIX: Record<PaddleEnv, string> = {
  production: "pdl_live_",
  sandbox: "pdl_sdbx_",
};

/** Parse the required `--env sandbox|production` flag (also accepts `--env=…`). */
function envFromArgs(): PaddleEnv {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--env");
  const raw = i !== -1 ? argv[i + 1] : argv.find((a) => a.startsWith("--env="))?.slice("--env=".length);
  if (raw === "sandbox" || raw === "production") return raw;
  console.error(
    "✗ --env is required: `--env sandbox` or `--env production`.\n" +
      "  Via the Taskfile:  task backend:paddle:seed -- --env sandbox",
  );
  process.exit(1);
}

export function paddleFromEnv(): { paddle: Paddle; envName: PaddleEnv; keyVar: string; keyMasked: string } {
  const envName = envFromArgs();
  const keyVar = KEY_VAR[envName];
  const apiKey = process.env[keyVar];
  if (!apiKey) {
    console.error(`✗ ${keyVar} is required for --env ${envName}. Export it in your shell (never commit it).`);
    process.exit(1);
  }
  if (!apiKey.startsWith(KEY_PREFIX[envName])) {
    console.error(
      `✗ ${keyVar} doesn't hold a ${envName} key (expected a ${KEY_PREFIX[envName]}… prefix).\n` +
        `  Wrong key in the slot — fix the export, don't change the flag.`,
    );
    process.exit(1);
  }
  const paddle = new Paddle(apiKey, {
    environment: envName === "production" ? Environment.production : Environment.sandbox,
  });
  return { paddle, envName, keyVar, keyMasked: `${apiKey.slice(0, 16)}…(masked)` };
}
