/**
 * Full-window sign-in gate. Two lanes: Google (system browser, handled in main) and
 * the email one-time-code lane (5b-3, in-app). The email flow is a small local step machine —
 * choose → enter email → enter code — because its transient UI state isn't worth putting on the global
 * auth status; on success the daemon/vault machinery takes over from the emitted ID token exactly like
 * Google. Copy is plain uploader voice.
 */
import { useState } from "react";
import { Button, Field } from "../ui/primitives.tsx";
import { BrandMark } from "../ui/brand-mark.tsx";
import type { AuthStatus } from "../../../shared/ipc.ts";

/** Google's four-color "G", per their sign-in branding guidelines — only ever rendered inside the
 * Continue-with-Google button, so it lives here rather than in the DS primitives. */
const GoogleGlyph = (): React.JSX.Element => (
  <svg className="cs-google-glyph" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
    <path
      fill="#4285F4"
      d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
    />
    <path
      fill="#34A853"
      d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
    />
    <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
    <path
      fill="#EA4335"
      d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
    />
  </svg>
);

interface Props {
  auth: AuthStatus;
  onSignIn: () => void;
  onEmailStart: (email: string) => Promise<void>;
  onEmailSubmit: (code: string) => Promise<void>;
  onEmailCancel: () => void;
  /** Abandon an in-progress browser sign-in — the way back out when the browser tab got closed. */
  onCancelSignIn: () => void;
  /** Startup: the real sign-in state isn't known yet — show the card with a disabled "Checking…" button. */
  checking?: boolean;
}

type Step = "choose" | "email" | "code";

export const SignInView = ({
  auth,
  onSignIn,
  onEmailStart,
  onEmailSubmit,
  onEmailCancel,
  onCancelSignIn,
  checking = false,
}: Props): React.JSX.Element => {
  const [step, setStep] = useState<Step>("choose");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = (): void => {
    setStep("choose");
    setEmail("");
    setCode("");
    setErr(null);
    setBusy(false);
    onEmailCancel();
  };

  const sendCode = (): void => {
    if (!email.trim() || busy) return;
    setBusy(true);
    setErr(null);
    onEmailStart(email).then(
      () => {
        setStep("code");
        setBusy(false);
      },
      (e: unknown) => {
        setErr(e instanceof Error ? e.message : "Couldn't send a code to that email.");
        setBusy(false);
      },
    );
  };

  const verify = (): void => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setErr(null);
    // On success the auth status flips to signedIn and this whole view unmounts — leave busy set.
    onEmailSubmit(code).catch((e: unknown) => {
      setErr(e instanceof Error && e.message ? "That code didn't work. Check it and try again." : "That code didn't work.");
      setBusy(false);
      void e;
    });
  };

  const body = (): React.JSX.Element => {
    if (checking) {
      return (
        <Button variant="primary" full disabled>
          Checking…
        </Button>
      );
    }
    if (auth.state === "signingIn") {
      return (
        <>
          <p className="cs-signin-text">Finish signing in in your browser.</p>
          <Button variant="ghost" onClick={onSignIn}>
            Open the browser again
          </Button>
          {/* Closing the browser tab sends no callback, so this is the ONLY way back to the lane
              choice — without it the card sits here until the attempt times out. */}
          <button
            type="button"
            className="cs-linkbtn"
            onClick={() => {
              setStep("choose");
              onCancelSignIn();
            }}
          >
            Cancel
          </button>
        </>
      );
    }
    if (step === "email") {
      return (
        <>
          <p className="cs-signin-text">We&apos;ll email you a one-time code — no password.</p>
          <Field
            label="Email"
            type="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendCode()}
          />
          {err && <p className="cs-signin-error">{err}</p>}
          <Button variant="primary" full disabled={!email.trim() || busy} onClick={sendCode}>
            {busy ? "Sending…" : "Email me a code"}
          </Button>
          <button type="button" className="cs-linkbtn" onClick={reset}>
            Back
          </button>
        </>
      );
    }
    if (step === "code") {
      return (
        <>
          <p className="cs-signin-text">
            Enter the code we sent to <strong>{email}</strong>.
          </p>
          <Field
            label="Code"
            mono
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && verify()}
          />
          {err && <p className="cs-signin-error">{err}</p>}
          <Button variant="primary" full disabled={!code.trim() || busy} onClick={verify}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
          <button type="button" className="cs-linkbtn" onClick={reset}>
            Use a different email
          </button>
        </>
      );
    }
    // choose
    return (
      <>
        <p className="cs-signin-text">Sign in to get started.</p>
        <button type="button" className="cs-btn cs-btn--full cs-btn--google" onClick={onSignIn}>
          <GoogleGlyph />
          Continue with Google
        </button>
        {auth.emailAvailable && (
          <button type="button" className="cs-linkbtn" onClick={() => setStep("email")}>
            Use an email code instead
          </button>
        )}
        {auth.error && <p className="cs-signin-error">Sign-in didn&apos;t complete: {auth.error}</p>}
      </>
    );
  };

  return (
    <div className="cs-signin">
      {/* Cardless "open ice" gate: the cube + wordmark float directly on the shell glow, the same
          transparent-over-glow treatment as the sidebar — sign-in is the first frame of the app,
          not a card in front of it. (Recovery/onboarding keep the .cs-signin-card frame.) */}
      <div className="cs-signin-gate">
        <BrandMark />
        <h1 className="cs-signin-word">coldstorage</h1>
        {body()}
      </div>
      {/* Sign-in-wrap agreement: continuing IS the acceptance (recorded server-side, versioned —
          see account-backend TERMS_VERSION). Anchored to the window edge so it sits under every
          step of the gate; links open the site in the system browser. */}
      {!checking && (
        <p className="cs-signin-legal">
          By continuing, you agree to the{" "}
          <a href="https://www.coldstorage.sh/terms" target="_blank" rel="noreferrer">
            Terms of Service
          </a>{" "}
          and{" "}
          <a href="https://www.coldstorage.sh/privacy" target="_blank" rel="noreferrer">
            Privacy Policy
          </a>
          .
        </p>
      )}
    </div>
  );
};
