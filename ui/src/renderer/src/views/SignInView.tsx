/**
 * Full-window sign-in gate (PROD.md Phase 5). Rendered instead of the shell when sign-in is
 * configured and nobody's signed in — the multi-user app has no anonymous mode (uploads need a
 * per-user vault prefix). Google only for now; the email-code lane lands with 5b.
 *
 * The actual flow happens in the main process + the system browser: the button just asks main to
 * start it, then this screen waits for the status push. Copy is plain uploader voice — the browser
 * does the talking.
 */
import { Button } from "../ui/primitives.tsx";
import type { AuthStatus } from "../../../shared/ipc.ts";

interface Props {
  auth: AuthStatus;
  onSignIn: () => void;
}

export const SignInView = ({ auth, onSignIn }: Props): React.JSX.Element => (
  <div className="cs-signin">
    <div className="cs-signin-card">
      <h1 className="cs-signin-title">ColdStorage</h1>
      {auth.state === "signingIn" ? (
        <>
          <p className="cs-signin-text">Finish signing in in your browser.</p>
          <Button variant="ghost" onClick={onSignIn}>
            Start over
          </Button>
        </>
      ) : (
        <>
          <p className="cs-signin-text">Sign in to get started.</p>
          <Button variant="primary" full onClick={onSignIn}>
            Continue with Google
          </Button>
        </>
      )}
      {auth.error && <p className="cs-signin-error">Sign-in didn&apos;t complete: {auth.error}</p>}
    </div>
  </div>
);
