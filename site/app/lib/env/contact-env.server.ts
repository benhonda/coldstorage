import { z } from "zod";

/**
 * Contact-form config — the CD2 sender key and the Cloudflare Turnstile pair.
 *
 * All three are OPTIONAL at boot, following the `paddle-env.server.ts` precedent and for the
 * same reason: the marketing site is mostly static pages, and it must start in local dev (and
 * on a fresh deploy, before Terraform has set the secrets) without a mailer configured. The
 * cost of that choice is paid at request time, not hidden — `sendContactMessage` refuses to
 * pretend, returns a "not configured" result, and logs loudly on the server.
 *
 * - `CD2_API_KEY` is a secret. The CD2 base URL is deliberately NOT an env var (hardcoded in
 *   `contact-mailer.server.ts`, per the CD2 docs).
 * - `TURNSTILE_SECRET_KEY` is the secret half of the widget pair; it never reaches the client.
 * - `PUBLIC_TURNSTILE_SITE_KEY` is the public half — it's rendered into the widget markup, so
 *   it's `PUBLIC_`-prefixed and reaches the browser via `window.env`.
 *
 * When Turnstile is unconfigured the form still sends and the server logs that it accepted a
 * message without a spam check. That's the one honest option: silently dropping messages, or
 * silently skipping the check without saying so, are both worse.
 */
const contactEnv = z
  .object({
    /** CD2 sender API key (sent as the X-API-Key header). Secret — server only. */
    CD2_API_KEY: z.string().optional(),
    /** Cloudflare Turnstile secret key, for the server-side siteverify call. Secret. */
    TURNSTILE_SECRET_KEY: z.string().optional(),
    /** Cloudflare Turnstile site key — public by design; rendered into the widget. */
    PUBLIC_TURNSTILE_SITE_KEY: z.string().optional(),
  })
  .parse(process.env);

export { contactEnv };
