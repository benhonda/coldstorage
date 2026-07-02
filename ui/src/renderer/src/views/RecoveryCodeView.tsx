/**
 * The two recovery-code moments of the zero-knowledge vault (PROD.md Phase 5b), both full-window gates
 * shown between sign-in and the shell:
 *
 *  - {@link RecoveryCodeShow} — once, right after signup: the one-time code that is the ONLY way back
 *    into the vault on a new device (or if this device is reset). We can't recover it — say so plainly,
 *    no drama. The user copies it, confirms they saved it, and we clear it from memory.
 *  - {@link RecoveryCodeEnter} — on a new device for an existing account: enter the saved code to unlock.
 *
 * Voice: plain and factual (no "safe", no fear-mongering) — it's a code you keep, like any other.
 */
import { useState } from "react";
import { Button, Field } from "../ui/primitives.tsx";

/** Which account these vault screens are acting as — so a wrong-account sign-in is caught BEFORE the
 * user commits (saves a recovery code / types one in). "Not you?" is the escape hatch back to sign-in. */
const AccountLine = ({ email, onSignOut }: { email: string | null; onSignOut: () => void }): React.JSX.Element => (
  <p className="cs-signin-account">
    {email ? <>Signed in as <strong>{email}</strong></> : "Signed in"} ·{" "}
    <button type="button" className="cs-linkbtn" onClick={onSignOut}>
      Not you?
    </button>
  </p>
);

export const RecoveryCodeShow = ({
  code,
  email,
  onAcknowledge,
  onSignOut,
}: {
  code: string;
  email: string | null;
  onAcknowledge: () => void;
  onSignOut: () => void;
}): React.JSX.Element => {
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const copy = (): void => {
    void navigator.clipboard.writeText(code).then(() => setCopied(true));
  };

  return (
    <div className="cs-signin">
      <div className="cs-signin-card">
        <AccountLine email={email} onSignOut={onSignOut} />
        <h1 className="cs-signin-title">Save your recovery code</h1>
        <p className="cs-signin-text">
          This code is how you get back into your files on another computer. It&apos;s shown once and
          can&apos;t be looked up later — keep it somewhere you won&apos;t lose it.
        </p>
        <code className="cs-recovery-code">{code}</code>
        <Button variant="secondary" full icon={copied ? "check" : "content_copy"} onClick={copy}>
          {copied ? "Copied" : "Copy code"}
        </Button>
        <label className="cs-recovery-confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          I&apos;ve saved my recovery code
        </label>
        <Button variant="primary" full disabled={!confirmed} onClick={onAcknowledge}>
          Continue
        </Button>
      </div>
    </div>
  );
};

/** The in-between vault states while signed in: provisioning (a brief loading moment) or an error
 * (retried automatically on the next daemon reconnect / token refresh; sign-out is the escape hatch). */
export const VaultGate = ({
  state,
  error,
  email,
  onSignOut,
}: {
  state: "locked" | "provisioning" | "error";
  error: string | null;
  email: string | null;
  onSignOut: () => void;
}): React.JSX.Element => (
  <div className="cs-signin">
    <div className="cs-signin-card">
      <AccountLine email={email} onSignOut={onSignOut} />
      {state === "error" ? (
        <>
          <h1 className="cs-signin-title">Couldn&apos;t set up encryption</h1>
          <p className="cs-signin-text">
            {error ?? "Something went wrong."} It&apos;ll try again on its own — check your connection.
          </p>
          <Button variant="ghost" onClick={onSignOut}>
            Sign out
          </Button>
        </>
      ) : (
        <>
          <h1 className="cs-signin-title">Setting up…</h1>
          <p className="cs-signin-text">One moment while your encryption is set up on this computer.</p>
        </>
      )}
    </div>
  </div>
);

export const RecoveryCodeEnter = ({
  email,
  onSubmit,
  onSignOut,
}: {
  email: string | null;
  onSubmit: (code: string) => Promise<void>;
  onSignOut: () => void;
}): React.JSX.Element => {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    onSubmit(code).catch((e: unknown) => {
      setError("That code didn't work. Check it and try again.");
      setBusy(false);
      void e;
    });
    // On success the vault status flips to "unlocked" and this view unmounts — no need to reset busy.
  };

  return (
    <div className="cs-signin">
      <div className="cs-signin-card">
        <AccountLine email={email} onSignOut={onSignOut} />
        <h1 className="cs-signin-title">Enter your recovery code</h1>
        <p className="cs-signin-text">
          This is a new computer. Enter the recovery code you saved when you first signed up to unlock
          your files here.
        </p>
        <Field
          label="Recovery code"
          mono
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
          value={code}
          autoFocus
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {error && <p className="cs-signin-error">{error}</p>}
        <Button variant="primary" full disabled={!code.trim() || busy} onClick={submit}>
          {busy ? "Unlocking…" : "Unlock"}
        </Button>
      </div>
    </div>
  );
};
