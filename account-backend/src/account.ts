import { z } from "zod";
import { surveySchema } from "./survey.js";

/**
 * Pure half of the /account route (routes/account.ts) — the PATCH contract + terms version,
 * kept import-safe for unit tests (no db/env), same split as catalog.ts / catalog.server.ts.
 */

/** Bump on a MATERIAL terms change (coldstorage.sh/terms) — stale accounts re-agree at next sign-in. */
export const TERMS_VERSION = "2026-07-16";

/**
 * The single write surface for account profile + onboarding facts. Booleans are *events*
 * ("this just happened"), stamped server-side into timestamps — the client never supplies a
 * clock, and an event can't be un-happened (`onboarded: false` is invalid input, not a rewind).
 */
export const accountPatchSchema = z
  .object({
    /** Trimmed by the app too, but never trust a client to have done it. */
    displayName: z
      .string()
      .transform((s) => s.trim())
      .pipe(z.string().min(1).max(64)),
    /** "The user agreed to the CURRENT terms" — stamps termsVersion + termsAcceptedAt. */
    acceptTerms: z.literal(true),
    /** "The wizard finished" — stamps onboardedAt. */
    onboarded: z.literal(true),
    /** "The user ticked 'I've saved my recovery code'" — stamps recoveryCodeConfirmedAt. */
    recoveryCodeConfirmed: z.literal(true),
    survey: surveySchema,
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty patch" });

export type AccountPatch = z.infer<typeof accountPatchSchema>;
