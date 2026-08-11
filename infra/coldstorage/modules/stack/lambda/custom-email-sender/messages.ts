/**
 * Which Cognito email events this sender handles, and what each one is CALLED to the user.
 *
 * Pure + unit-tested (messages.test.ts) — the handler does the crypto and the network, this decides
 * the message. Kept separate for the same reason pre-signup/decide.ts is: the interesting part is a
 * decision table, and a decision table deserves tests that don't need a KMS key or an HTTP client.
 *
 * IMPORTANT — once the custom sender trigger is wired, Cognito sends NOTHING itself. Every trigger
 * source that isn't handled here is an email the user never receives, so `messageFor` returns null
 * and the handler THROWS rather than dropping it silently (PILLAR5).
 */

/** The trigger sources our pool can actually produce. Both are "here's your code" to the user. */
export type HandledTriggerSource = "CustomEmailSender_SignUp" | "CustomEmailSender_Authentication";

export type CodeMessage = {
  subject: string;
  /** Shown by mail clients next to the subject. Deliberately code-free — it lands on lock screens. */
  preheader: string;
  /** Why this code exists, in the user's terms. First line of the email body. */
  intro: string;
};

/**
 * The two code emails, spelled out separately even though they render the same template: a brand-new
 * account and a returning sign-in are different moments, and the copy should know which one it is.
 */
const MESSAGES: Record<HandledTriggerSource, CodeMessage> = {
  // A first-time email: SignUp (no password) is how cognito-idp.ts creates an account, so this is
  // the very first thing ColdStorage ever sends a person.
  CustomEmailSender_SignUp: {
    subject: "Your ColdStorage code",
    preheader: "The code to finish setting up your account.",
    intro: "Welcome to ColdStorage. Here's the code to finish setting up your account:",
  },
  // The everyday one: InitiateAuth with PREFERRED_CHALLENGE=EMAIL_OTP on an existing user.
  CustomEmailSender_Authentication: {
    subject: "Your ColdStorage sign-in code",
    preheader: "The code to finish signing in.",
    intro: "Here's the code to finish signing in:",
  },
};

/**
 * The message for a trigger source, or null if we don't send mail for it.
 *
 * Null is expected for the sources our pool can't produce — ForgotPassword (nobody has a password),
 * AdminCreateUser (the pre-sign-up shell is created with MessageAction: SUPPRESS), ResendCode and the
 * attribute-verification pair (the app never calls them), AccountTakeOverNotification (threat
 * protection is off). If one of those ever starts firing, we want the loud failure, not a shrug.
 */
export const messageFor = (triggerSource: string): CodeMessage | null =>
  triggerSource in MESSAGES ? MESSAGES[triggerSource as HandledTriggerSource] : null;
