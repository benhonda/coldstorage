/*
 * Contact form — the server half: verify the Turnstile token, then hand the message to CD2.
 *
 * Kept out of the route file so the route stays a thin `action` and this stays testable. The
 * split mirrors the contract in `contact.ts`, which both halves import.
 */
import { EmailClient } from "@cdv2/email";
import { contactEnv } from "~/lib/env/contact-env.server";
import { SUPPORT_EMAIL } from "~/lib/marketing/legal";
import type { ContactInput } from "~/lib/marketing/contact";

/**
 * Where contact-form mail comes FROM. Must be a domain CD2's API key is authorized to send
 * for, or the send 403s. This is the published support address, so a reply-all lands somewhere
 * monitored even if the recipient forgets to reply to the sender.
 */
const MAIL_FROM = `ColdStorage Contact Form <${SUPPORT_EMAIL}>`;
/** Where contact-form mail goes. */
const MAIL_TO = "ben@m.coldstorage.sh";
/** The CD2 sender API. Hardcoded per the CD2 docs — explicitly not an env var. */
const CD2_BASE_URL = "https://send.cd2.adpharm.digital";

/** Cloudflare's server-side token validation endpoint. */
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verify a Turnstile token against Cloudflare.
 *
 * Returns `true` when the check passed AND when Turnstile isn't configured at all — the
 * unconfigured case is logged as a warning rather than silently swallowed, because a spam
 * check that quietly isn't running is the failure mode you find out about via the inbox.
 *
 * Tokens are single-use and expire after five minutes; a replayed one comes back as
 * `timeout-or-duplicate`, which is a legitimate failure and is treated as one.
 */
export async function verifyTurnstile(token: string | null, remoteip?: string): Promise<boolean> {
  const secret = contactEnv.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.warn(
      "[contact] TURNSTILE_SECRET_KEY is not set — accepting this message without a spam check."
    );
    return true;
  }
  if (!token) return false;

  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token, ...(remoteip ? { remoteip } : {}) }),
    });
    const result = (await res.json()) as { success: boolean; "error-codes"?: string[] };
    if (!result.success) {
      console.warn("[contact] Turnstile rejected a token:", result["error-codes"]?.join(", "));
    }
    return result.success;
  } catch (err) {
    // A network failure reaching Cloudflare is ours, not the sender's. Refuse rather than
    // wave the message through — a contact form is exactly what a bot goes looking for.
    console.error("[contact] Turnstile verification could not be reached:", err);
    return false;
  }
}

/**
 * Send the message through CD2. Returns whether it was ACCEPTED — not whether it was
 * delivered. CD2 queues and SES delivers asynchronously, so a `true` here means the sender
 * took it, and final status would have to be polled via `client.get(id)`. For a contact form
 * that's the right place to stop: the sender has done its job, and a bounce to our own inbox
 * is our problem to notice, not something to make the visitor wait on.
 */
export async function sendContactMessage(
  input: ContactInput,
  meta: { userAgent?: string }
): Promise<boolean> {
  const apiKey = contactEnv.CD2_API_KEY;
  if (!apiKey) {
    console.error("[contact] CD2_API_KEY is not set — the message was NOT sent.");
    return false;
  }

  const client = new EmailClient({ apiKey, baseUrl: CD2_BASE_URL });

  // The SDK never throws — it returns `{ data, error }`. Branch on `error` first.
  const { data, error } = await client.send({
    from: MAIL_FROM,
    to: MAIL_TO,
    // `replyTo` is the whole point: hitting reply in the inbox writes back to the person.
    replyTo: input.email,
    subject: `Contact form — ${input.name}`,
    text: plainBody(input, meta),
    html: htmlBody(input, meta),
  });

  if (error) {
    console.error("[contact] CD2 refused the message:", error.message);
    return false;
  }

  console.info("[contact] message accepted by CD2:", data.id);
  return true;
}

function plainBody(input: ContactInput, meta: { userAgent?: string }): string {
  return [
    `From: ${input.name} <${input.email}>`,
    meta.userAgent ? `User agent: ${meta.userAgent}` : null,
    "",
    input.message,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function htmlBody(input: ContactInput, meta: { userAgent?: string }): string {
  return [
    `<p><strong>From:</strong> ${escapeHtml(input.name)} &lt;${escapeHtml(input.email)}&gt;</p>`,
    meta.userAgent ? `<p><strong>User agent:</strong> ${escapeHtml(meta.userAgent)}</p>` : "",
    `<hr />`,
    `<p style="white-space:pre-wrap">${escapeHtml(input.message)}</p>`,
  ].join("\n");
}

/**
 * Escape submitted text before it goes into the HTML body. The message is attacker-controlled
 * and lands in a mail client, so it gets escaped rather than trusted.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
