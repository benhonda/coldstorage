/**
 * Full-window sign-in gate (PROD.md Phase 5). Two lanes: Google (system browser, handled in main) and
 * the email one-time-code lane (5b-3, in-app). The email flow is a small local step machine —
 * choose → enter email → enter code — because its transient UI state isn't worth putting on the global
 * auth status; on success the daemon/vault machinery takes over from the emitted ID token exactly like
 * Google. Copy is plain uploader voice.
 */
import { useState } from "react";
import { Button, Field } from "../ui/primitives.tsx";
import type { AuthStatus } from "../../../shared/ipc.ts";

interface Props {
  auth: AuthStatus;
  onSignIn: () => void;
  onEmailStart: (email: string) => Promise<void>;
  onEmailSubmit: (code: string) => Promise<void>;
  onEmailCancel: () => void;
  /** Startup: the real sign-in state isn't known yet — show the card with a disabled "Checking…" button. */
  checking?: boolean;
}

type Step = "choose" | "email" | "code";

export const SignInView = ({ auth, onSignIn, onEmailStart, onEmailSubmit, onEmailCancel, checking = false }: Props): React.JSX.Element => {
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
            Start over
          </Button>
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
        <Button variant="primary" full onClick={onSignIn}>
          Continue with Google
        </Button>
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
      <div className="cs-signin-card">
        <h1 className="cs-signin-title">ColdStorage</h1>
        {body()}
        {/* Sign-in-wrap agreement: continuing IS the acceptance (recorded server-side, versioned —
            see account-backend TERMS_VERSION). Shown on every step of the card so it always sits
            with the action it governs; links open the site in the system browser. */}
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
    </div>
  );
};
