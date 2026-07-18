/*
 * Contact-form contract — the field names, the validation schema, and the result shape the
 * route's action returns. Deliberately NOT a `.server` module: the form component imports the
 * same schema and the same field names, so the browser and the action can't drift apart about
 * what "a valid message" means (PILLAR3 — one definition, PILLAR4 — one inferred type).
 *
 * The user-facing strings for each failure live in `CONTACT_PAGE.form.errors` (content.ts, the
 * copy SSOT). This file names the failure; it doesn't word it.
 */
import { z } from "zod";

/** Form field names — used for the `name` attributes and for reading the submitted FormData. */
export const CONTACT_FIELDS = {
  name: "name",
  email: "email",
  message: "message",
  /** The Turnstile widget posts its token under this exact name; it is not ours to rename. */
  token: "cf-turnstile-response",
} as const;

/**
 * What a valid message is. Lengths are generous on purpose — a real support message about a
 * failed upload runs long, and a truncated one costs a round trip to ask for the rest.
 */
export const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  message: z.string().trim().min(1).max(10_000),
});

export type ContactInput = z.infer<typeof contactSchema>;

/** Which field a validation failure belongs to — drives which message the form shows. */
export type ContactFieldError = keyof ContactInput;

/**
 * What the action returns. `ok` is the only success; every failure says which one it was so
 * the form can show the right message instead of a generic "something went wrong" (CORE9).
 */
export type ContactResult =
  | { status: "ok" }
  | { status: "invalid"; fields: ContactFieldError[] }
  | { status: "turnstile" }
  | { status: "failed" };
