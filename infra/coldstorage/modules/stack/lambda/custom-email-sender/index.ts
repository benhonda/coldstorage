/**
 * Cognito custom-email-sender trigger — ColdStorage's one-time codes, sent as OUR email.
 *
 * Wired to the user pool by infra (`lambda.tf` → `lambda_config.custom_email_sender` + `kms_key_id`).
 * Once that trigger exists, Cognito stops sending mail entirely: instead of posting its own
 * no-reply@verificationemail.com message, it encrypts the code with our KMS key and hands it to this
 * function, which decrypts it, renders the branded template (emails/code-email.tsx) and sends it
 * through CD2 from the verified `m.coldstorage.sh` sender.
 *
 * FAILURE POSTURE — read this before "improving" the error handling. Custom sender triggers are the
 * ONE Cognito trigger type invoked ASYNCHRONOUSLY ("Except for Custom sender Lambda triggers, Amazon
 * Cognito invokes Lambda functions synchronously" — Cognito docs, Things to know about Lambda
 * triggers). Two consequences that shape everything below:
 *
 *   1. Throwing does NOT reach the user. Their sign-in call has already returned "code sent"; a throw
 *      here is invisible to them and they simply wait for mail that never comes. So a throw is not a
 *      user-facing error message, it is a SIGNAL TO THE PLATFORM — which is exactly why every failure
 *      path still throws rather than returning quietly, and why the alarm on this function's Errors
 *      metric is the thing that makes a failure visible to us (PILLAR5). Nothing here can make it
 *      visible to the person waiting; only the app's own "resend" affordance can.
 *   2. Async invocation means Lambda RETRIES a throw (twice, per the function's invoke config). That
 *      is a real feature here: a transient CD2 blip heals itself without the user touching anything.
 *      It also means every failure path must be safe to run twice — sending a duplicate code email is
 *      acceptable (both codes are valid), which is why retries are left on.
 *
 * There is deliberately no second mail path to fall back to (AVOID4) — Cognito sends nothing once
 * this trigger is wired, and a half-branded fallback would be worse than a retry.
 *
 * Latency matters — a human is watching an empty inbox. CD2's send() returns on ACCEPTED, not
 * delivered, which is the right trade for an interactive flow: we don't poll get() (that would add
 * seconds to every sign-in), we log the id so a delivery question is answerable after the fact.
 */
import { buildClient, CommitmentPolicy, KmsKeyringNode } from "@aws-crypto/client-node";
import { EmailClient } from "@cdv2/email";
import { render } from "@react-email/render";
import type { CustomEmailSenderTriggerEvent } from "aws-lambda";
import { createElement } from "react";
import { CodeEmail } from "./emails/code-email.js";
import { maskEmail } from "./log.js";
import { messageFor } from "./messages.js";

/** Read once at cold start — a missing one is a deploy bug, and should break loudly and immediately. */
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
};

const KMS_KEY_ARN = required("KMS_KEY_ARN");
const MAIL_FROM = required("MAIL_FROM");

const { decrypt } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_ALLOW_DECRYPT);
/** Cognito encrypts under this one key, so it is both the generator and the only permitted key. */
const keyring = new KmsKeyringNode({ generatorKeyId: KMS_KEY_ARN, keyIds: [KMS_KEY_ARN] });

const mailer = new EmailClient({
  apiKey: required("CD2_API_KEY"),
  // Hardcoded per the CD2 docs — the production sender API is not an environment concern.
  baseUrl: "https://send.cd2.adpharm.digital",
});

/**
 * Cognito wanted to mail this person and now nothing will — see messages.ts for why none of the
 * unhandled sources should be reachable in this pool.
 *
 * The type annotation is on the CONST, not just the arrow: that is what lets TypeScript treat a call
 * as terminating control flow, which is what narrows `event` past the guards below. Inferred-`never`
 * arrow functions don't get that treatment.
 */
const unhandled: (triggerSource: string) => never = (triggerSource) => {
  throw new Error(`unhandled custom email sender trigger source: ${triggerSource}`);
};

export const handler = async (event: CustomEmailSenderTriggerEvent): Promise<void> => {
  // Split off the one event whose SHAPE differs (its userAttributes are takeover metadata, not the
  // user's profile) before reading any of them — that keeps the rest of this function on the plain
  // StringMap without a cast (PILLAR4). Threat protection is off, so it should never arrive.
  if (event.triggerSource === "CustomEmailSender_AccountTakeOverNotification") unhandled(event.triggerSource);

  const message = messageFor(event.triggerSource);
  if (!message) unhandled(event.triggerSource);

  // Both shape checks BEFORE the decrypt: a KMS round trip is the expensive part of this function,
  // and there is no point spending it to discover we had nowhere to send the result.
  const encrypted = event.request.code;
  if (!encrypted) throw new Error(`no code on a ${event.triggerSource} event`);
  const to = event.request.userAttributes.email;
  if (!to) throw new Error(`no email attribute on a ${event.triggerSource} event`);

  const { plaintext } = await decrypt(keyring, Buffer.from(encrypted, "base64"));
  const code = Buffer.from(plaintext).toString("utf-8");

  // createElement, not CodeEmail(...): this file is .ts so there's no JSX, and calling the component
  // directly would render its tree outside React's component semantics. Same result today, but it's
  // the difference between "a component" and "a function that happens to return elements".
  const element = createElement(CodeEmail, { ...message, code });
  // Both bodies, always — text/plain is what plain-text clients and spam filters read, and CD2's
  // docs call sending both out explicitly as a deliverability win.
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);

  const { data, error } = await mailer.send({ from: MAIL_FROM, to, subject: message.subject, html, text });
  // The SDK never throws — it returns a discriminated union, so branch on `error` first.
  if (error) throw new Error(`CD2 refused the ${event.triggerSource} code email: ${error.message}`);

  console.log(`sent ${event.triggerSource} code to ${maskEmail(to)} — cd2 id ${data.id}`);
};
