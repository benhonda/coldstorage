/**
 * The handler's FAIL-LOUD contract, pinned.
 *
 * Every one of these paths is a case where nobody gets an email. Because Cognito invokes this
 * trigger asynchronously, a `return` instead of a `throw` on any of them would be completely
 * silent — no user-visible error, no Errors metric, no alarm, just a person waiting forever. That
 * is the exact failure the alarms in alerts.tf exist to catch, and they only work if the function
 * actually throws. So these tests guard the throw itself.
 *
 * They exercise the REAL module (no mocking): the guards all run before the first KMS or CD2 call,
 * so the only setup needed is the environment the module reads at cold start. That also makes this
 * an honest smoke test that the bundle's imports — the AWS Encryption SDK, react, CD2 — initialise.
 */
import { beforeAll, describe, expect, test } from "bun:test";

type Handler = (event: unknown) => Promise<void>;
let handler: Handler;

beforeAll(async () => {
  // Values only need to be well-shaped, not real — nothing here reaches AWS or CD2.
  process.env.KMS_KEY_ARN = "arn:aws:kms:ca-central-1:111122223333:key/1example-2222-3333-4444-999example";
  process.env.MAIL_FROM = "coldstorage <noreply@m.coldstorage.sh>";
  process.env.CD2_API_KEY = "cd2-test-key";
  // Imported here, not at the top: the module reads the environment at import time by design.
  ({ handler } = (await import("./index.js")) as { handler: Handler });
});

/** A well-formed event, so each test can break exactly one thing. */
const event = (
  overrides: Record<string, unknown> = {},
): { triggerSource: string; request: { code: string | null; userAttributes: Record<string, string> } } => ({
  triggerSource: "CustomEmailSender_Authentication",
  request: { code: "encrypted-blob", userAttributes: { email: "ben@example.com" } },
  ...overrides,
});

describe("handler fail-loud contract", () => {
  test("a trigger source we don't send mail for throws rather than dropping the email", async () => {
    // ForgotPassword shouldn't be reachable (nobody has a password), which is exactly why arriving
    // here should be loud instead of a shrug.
    await expect(handler(event({ triggerSource: "CustomEmailSender_ForgotPassword" }))).rejects.toThrow(
      /unhandled custom email sender trigger source: CustomEmailSender_ForgotPassword/,
    );
  });

  test("the account-takeover event throws too — its payload shape isn't a user profile", async () => {
    await expect(handler(event({ triggerSource: "CustomEmailSender_AccountTakeOverNotification" }))).rejects.toThrow(
      /unhandled custom email sender trigger source/,
    );
  });

  test("an event with no code throws instead of mailing a blank one", async () => {
    const e = event();
    e.request.code = null;
    await expect(handler(e)).rejects.toThrow(/no code on a CustomEmailSender_Authentication event/);
  });

  test("an event with no email attribute throws instead of sending to nowhere", async () => {
    const e = event();
    e.request.userAttributes = {};
    await expect(handler(e)).rejects.toThrow(/no email attribute/);
  });
});
