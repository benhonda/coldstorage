/**
 * The pure decision core of the pre-sign-up trigger (PROD.md "same email, two sign-in methods").
 *
 * ONE EMAIL = ONE ACCOUNT: a federated (Google) first sign-in must land in the same user-pool user
 * an email-code account with the same address uses — linked at the door, so a second vault (second
 * key-blob, second S3 prefix) can never fork off. This module is pure — the handler (index.ts) does
 * the AWS calls — so every branch of the table is unit-testable without Cognito.
 *
 * Linking is keyed on VERIFIED email only, on both sides: the IdP must say `email_verified` (else
 * auto-linking is the classic account-takeover vector — the reason Auth.js names its flag
 * `allowDangerousEmailAccountLinking`), and the native destination must be a CONFIRMED user whose
 * email was proven by our OTP. An unverified federated email proceeds UNLINKED (a separate account —
 * safe, merely suboptimal) rather than trusting an unproven address.
 */

/** One existing pool user with the same email, as the handler found it via ListUsers. */
export interface ExistingUser {
  username: string;
  /** Cognito UserStatus — "CONFIRMED", "UNCONFIRMED", "EXTERNAL_PROVIDER", … */
  status: string;
  emailVerified: boolean;
  /** Has an `identities` attribute — an external-IdP profile (Google/Apple), not a native user. */
  federated: boolean;
}

export type Decision =
  /** Nothing to do — normal signup/sign-in proceeds unchanged. */
  | { action: "proceed" }
  /** Federated sign-up, and a usable native account exists → link the IdP identity into it. */
  | { action: "linkToExisting"; destinationUsername: string }
  /**
   * Federated sign-up with no usable native account → create a native shell user (passwordless →
   * CONFIRMED) and link into it, so the account is native-parented from birth and a later
   * email-code sign-in lands on the SAME account with no special case. Stale native profiles
   * (abandoned UNCONFIRMED signups) are deleted first — they'd collide with the email alias, and
   * linking into an unverified profile is exactly the takeover shape the verified-email rule bans.
   */
  | { action: "createShellAndLink"; deleteStaleUsernames: string[] }
  /**
   * Native (email-code) signup against an email owned by an UNLINKED federated account — the
   * legacy/pre-trigger case. Cognito can only link federated→native, not the reverse, so the
   * signup is refused with copy the app surfaces verbatim.
   */
  | { action: "blockNativeSignUp"; message: string };

/** Shown by the app when an email-code signup hits a legacy unlinked Google account. */
export const BLOCKED_SIGNUP_MESSAGE = "This email signs in with Google — use Continue with Google.";

export const decide = (input: {
  /** The Cognito trigger source, e.g. "PreSignUp_SignUp" | "PreSignUp_ExternalProvider" | "PreSignUp_AdminCreateUser". */
  triggerSource: string;
  /** The incoming profile's email_verified claim (federated: from the IdP via attribute mapping). */
  emailVerified: boolean;
  /** Every OTHER pool user with this email (the handler excludes the profile being created). */
  existing: ExistingUser[];
}): Decision => {
  const { triggerSource, emailVerified, existing } = input;

  // Our own AdminCreateUser (the shell user, below) re-fires this trigger as
  // PreSignUp_AdminCreateUser — it must fall straight through or shell creation recurses/fails.
  if (triggerSource === "PreSignUp_AdminCreateUser") return { action: "proceed" };

  if (triggerSource === "PreSignUp_ExternalProvider") {
    // Unverified IdP email: never link (see header). Proceeds as a separate, unlinked profile.
    if (!emailVerified) return { action: "proceed" };

    const native = existing.filter((u) => !u.federated);
    const usable = native.find((u) => u.status === "CONFIRMED" && u.emailVerified);
    if (usable) return { action: "linkToExisting", destinationUsername: usable.username };

    // No usable native parent → mint one. Anything native-but-unusable is an abandoned signup
    // (never completed the OTP): delete it so the shell's email alias is free.
    return {
      action: "createShellAndLink",
      deleteStaleUsernames: native.map((u) => u.username),
    };
  }

  if (triggerSource === "PreSignUp_SignUp") {
    // A federated profile owns this email and nothing native exists to serve the sign-in — the
    // fork trap. (If a native user also exists, this signup fails Cognito's alias-uniqueness on
    // its own; no decision needed here.)
    if (existing.some((u) => u.federated) && !existing.some((u) => !u.federated)) {
      return { action: "blockNativeSignUp", message: BLOCKED_SIGNUP_MESSAGE };
    }
    return { action: "proceed" };
  }

  return { action: "proceed" };
};
