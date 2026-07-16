/**
 * The first-run wizard (ui/DESIGN.md §onboarding): name → a three-pane tour of how ColdStorage
 * actually works → the recovery code → two skippable questions → done. Every screen lives in the
 * same `.cs-signin` gate-card frame the sign-in flow uses, with progress dots on top.
 *
 * The step LIST is frozen at mount from the account's server-side facts (no displayName → ask;
 * not onboarded → tour + questions + done; recovery code unconfirmed → the code step) — so an
 * interrupted run resumes with exactly the steps still owed, and a finished one never re-runs.
 * Only the INDEX is local state. Fail-open posture: a failed name save offers "continue without
 * saving" (retried next launch), and the vault steps keep their own fail-closed gates.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Field, Icon } from "../ui/primitives.tsx";
import { RecoveryCodeShow, VaultGate } from "./RecoveryCodeView.tsx";
import { formatBytes } from "./files/model.ts";
import type { AccountStatus, AuthStatus, ColdstoreApi, SurveyAnswers, VaultStatus } from "../../../shared/ipc.ts";

/**
 * The survey option catalogs — ids mirror `account-backend/src/survey.ts` (the validation SSOT;
 * same hand-mirrored convention as protocol.ts). Labels are ours to reword; ids are what's stored.
 */
const KEEPING_OPTIONS = [
  { id: "photos-video", label: "Photos and home video" },
  { id: "drive-backups", label: "Old drives and computer backups" },
  { id: "finished-projects", label: "Finished work and creative projects" },
  { id: "documents-records", label: "Documents and records" },
  { id: "media-collection", label: "A media collection" },
  { id: "other", label: "Something else" },
] as const;

const FOUND_VIA_OPTIONS = [
  { id: "friend-colleague", label: "A friend or colleague" },
  { id: "web-search", label: "Web search" },
  { id: "social-media", label: "Social media" },
  { id: "youtube-podcast", label: "YouTube or a podcast" },
  { id: "article-newsletter", label: "An article or newsletter" },
  { id: "other", label: "Somewhere else" },
] as const;

type Step = "name" | "tour1" | "tour2" | "tour3" | "code" | "q1" | "q2" | "done";

/** Whether the wizard has anything to do for this account (App's activation predicate). */
export const onboardingPending = (account: AccountStatus): boolean =>
  account.known && (!account.displayName || !account.onboarded || !account.recoveryCodeConfirmed);

const Dots = ({ total, current }: { total: number; current: number }): React.JSX.Element => (
  <div className="cs-onb-dots" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={current + 1}>
    {Array.from({ length: total }, (_, i) => (
      <i key={i} className={i <= current ? "cs-onb-dot cs-onb-dot--on" : "cs-onb-dot"} />
    ))}
  </div>
);

const Pict = ({ icon }: { icon: string }): React.JSX.Element => (
  <span className="cs-onb-pict" aria-hidden="true">
    <Icon name={icon} size={30} />
  </span>
);

const AccountLine = ({ email, onSignOut }: { email: string | null; onSignOut: () => void }): React.JSX.Element => (
  <p className="cs-signin-account">
    {email ? (
      <>
        Signed in as <strong>{email}</strong>
      </>
    ) : (
      "Signed in"
    )}{" "}
    ·{" "}
    <button type="button" className="cs-linkbtn" onClick={onSignOut}>
      Not you?
    </button>
  </p>
);

/** A selectable option row (the survey questions) — full-width so long labels never wrap raggedly. */
const OptionRow = ({ label, selected, onToggle }: { label: string; selected: boolean; onToggle: () => void }): React.JSX.Element => (
  <button type="button" className={selected ? "cs-qrow cs-qrow--on" : "cs-qrow"} aria-pressed={selected} onClick={onToggle}>
    <span>{label}</span>
    {selected && <Icon name="check" size={18} />}
  </button>
);

interface Props {
  api: ColdstoreApi;
  auth: AuthStatus;
  vault: VaultStatus;
  account: AccountStatus;
  /** The signed-in account's byte quota (free tier or plan) — the "you're set" line. Null = unknown. */
  quotaBytes: number | null;
  /** Paid subscription? Picks the closing copy (the free-tier "forever" line is for free accounts). */
  subscribed: boolean;
  onSignOut: () => void;
  /** The final Continue — App drops the wizard for this session even if the server write failed. */
  onDone: () => void;
}

export const OnboardingWizard = ({ api, auth, vault, account, quotaBytes, subscribed, onSignOut, onDone }: Props): React.JSX.Element | null => {
  // Frozen at mount: the steps still owed, from the server-side facts (see the header comment).
  const [steps] = useState<Step[]>(() => {
    const s: Step[] = [];
    if (!account.displayName) s.push("name");
    if (!account.onboarded) s.push("tour1", "tour2", "tour3");
    if (!account.recoveryCodeConfirmed) s.push("code");
    if (!account.onboarded) s.push("q1", "q2", "done");
    return s;
  });
  const [idx, setIdx] = useState(0);

  // Name step (prefilled from Google's ID-token claim when it came along).
  const [name, setName] = useState(auth.name ?? "");
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  // Survey answers, collected locally and submitted once at the done step. Skips record nothing.
  const [keeping, setKeeping] = useState<Set<string>>(new Set());
  const [foundVia, setFoundVia] = useState<string | null>(null);
  const answersRef = useRef<SurveyAnswers>({});

  // Code step: whether we had to REISSUE (an interrupted earlier run — the copy differs), and any
  // reissue failure (retryable).
  const reissueStarted = useRef(false);
  const [reissued, setReissued] = useState(false);
  const [reissueError, setReissueError] = useState<string | null>(null);

  const step: Step | undefined = steps[idx];
  const next = (): void => setIdx((i) => Math.min(i + 1, steps.length - 1));
  const back = (): void => setIdx((i) => Math.max(i - 1, 0));

  // The code step with nothing to show: this device holds the key but the code was never confirmed
  // saved (the app died mid-signup, or predates this flow) — mint a fresh one. The old code stops
  // working, which the intro copy says plainly.
  const needsReissue = step === "code" && !vault.recoveryCode && vault.state === "unlocked";
  useEffect(() => {
    if (!needsReissue || reissueStarted.current) return;
    reissueStarted.current = true;
    setReissued(true);
    api.reissueRecoveryCode().catch((e: unknown) => {
      setReissueError(e instanceof Error ? e.message : String(e));
      reissueStarted.current = false; // allow a retry
    });
  }, [api, needsReissue]);

  if (!step) return null;

  const dots = <Dots total={steps.length} current={idx} />;

  const submitName = (skipSave = false): void => {
    if (nameBusy) return;
    if (skipSave) {
      next();
      return;
    }
    if (!name.trim()) return;
    setNameBusy(true);
    setNameError(null);
    api.setDisplayName(name).then(
      () => {
        setNameBusy(false);
        next();
      },
      (e: unknown) => {
        // Fail OPEN: the name is cosmetic — surface the error and offer to move on (it stays
        // askable in Settings, and the wizard re-derives next launch if nothing was saved).
        setNameError(e instanceof Error ? e.message : String(e));
        setNameBusy(false);
      },
    );
  };

  const confirmCode = (): void => {
    void api.acknowledgeRecoveryCode();
    // Best-effort: a failed fact-write means a fresh code gets re-shown next launch — annoying but
    // safe, and strictly better than blocking here on the account server.
    void api.confirmRecoveryCode().catch(() => undefined);
    next();
  };

  const finishQ1 = (skip: boolean): void => {
    if (!skip && keeping.size > 0) answersRef.current.keeping = [...keeping];
    next();
  };

  const finishQ2 = (skip: boolean): void => {
    if (!skip && foundVia) answersRef.current.foundVia = foundVia;
    // Entering the done step — record the answers (if any) now, quietly.
    const answers = answersRef.current;
    if (answers.keeping || answers.foundVia) void api.submitSurvey(answers).catch(() => undefined);
    next();
  };

  const finish = (): void => {
    // Quiet + fail-open: a failed write re-runs the wizard next launch; never strand the user here.
    void api.completeOnboarding().catch(() => undefined);
    onDone();
  };

  const card = (children: React.ReactNode): React.JSX.Element => (
    <div className="cs-signin">
      <div className="cs-signin-card">{children}</div>
    </div>
  );

  switch (step) {
    case "name":
      return card(
        <>
          {dots}
          <AccountLine email={auth.email} onSignOut={onSignOut} />
          <h1 className="cs-signin-title">What&apos;s your name?</h1>
          <p className="cs-signin-text">
            It shows on your account and in email we send you. You can change it anytime in Settings.
          </p>
          <Field
            label="Name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitName()}
          />
          {nameError && <p className="cs-signin-error">{nameError}</p>}
          <Button variant="primary" full disabled={!name.trim() || nameBusy} onClick={() => submitName()}>
            {nameBusy ? "Saving…" : "Continue"}
          </Button>
          {nameError && (
            <button type="button" className="cs-linkbtn" onClick={() => submitName(true)}>
              Continue without saving — add it later in Settings
            </button>
          )}
        </>,
      );

    case "tour1":
      return card(
        <>
          {dots}
          <Pict icon="ac_unit" />
          <h1 className="cs-signin-title">Storage that runs cold</h1>
          <p className="cs-signin-text">
            Your files are kept in deep archive — the cheapest storage there is, built for keeping things
            for years. The trade: bringing files back takes <strong>hours, not seconds</strong>. Small
            restores are free; big ones show a price before anything happens.
          </p>
          <Button variant="primary" full onClick={next}>
            Next
          </Button>
        </>,
      );

    case "tour2":
      return card(
        <>
          {dots}
          <Pict icon="drive_folder_upload" />
          <h1 className="cs-signin-title">Only what you deposit</h1>
          <p className="cs-signin-text">
            ColdStorage never scans your Mac or uploads anything on its own. You pick the files and
            folders to deposit, and the originals stay exactly where they are.
          </p>
          <Button variant="primary" full onClick={next}>
            Next
          </Button>
          <button type="button" className="cs-linkbtn" onClick={back}>
            Back
          </button>
        </>,
      );

    case "tour3":
      return card(
        <>
          {dots}
          <Pict icon="key" />
          <h1 className="cs-signin-title">Your data is only ever visible to you</h1>
          <p className="cs-signin-text">
            Everything is encrypted on this Mac before upload, with a key only you hold. We can&apos;t
            read your files by design, which means we can&apos;t unlock them for you either. That&apos;s
            what your recovery code is for. It&apos;s next.
          </p>
          <Button variant="primary" full onClick={next}>
            Next
          </Button>
          <button type="button" className="cs-linkbtn" onClick={back}>
            Back
          </button>
        </>,
      );

    case "code": {
      if (vault.recoveryCode) {
        return (
          <RecoveryCodeShow
            code={vault.recoveryCode}
            email={auth.email}
            onAcknowledge={confirmCode}
            onSignOut={onSignOut}
            header={dots}
            {...(reissued
              ? {
                  intro:
                    "It looks like you didn't finish saving your recovery code, so here's a fresh one. Any earlier code no longer works. It's how you get back into your files on another computer — keep it somewhere you won't lose it.",
                }
              : {})}
          />
        );
      }
      if (reissueError) {
        return card(
          <>
            {dots}
            <AccountLine email={auth.email} onSignOut={onSignOut} />
            <h1 className="cs-signin-title">Couldn&apos;t prepare a recovery code</h1>
            <p className="cs-signin-text">{reissueError}</p>
            <Button
              variant="primary"
              full
              onClick={() => {
                setReissueError(null);
                reissueStarted.current = false;
              }}
            >
              Try again
            </Button>
          </>,
        );
      }
      // The mint (fresh signup) or reissue is still working underneath — the same quiet gate the
      // vault flow already uses. Errors surface through the vault status exactly as before.
      return <VaultGate state={vault.state === "error" ? "error" : "provisioning"} error={vault.error} email={auth.email} onSignOut={onSignOut} />;
    }

    case "q1":
      return card(
        <>
          {dots}
          <h1 className="cs-signin-title">What are you keeping cold?</h1>
          <p className="cs-signin-text">Optional — it helps us make ColdStorage better. Pick any that fit.</p>
          <div className="cs-qrows">
            {KEEPING_OPTIONS.map((o) => (
              <OptionRow
                key={o.id}
                label={o.label}
                selected={keeping.has(o.id)}
                onToggle={() =>
                  setKeeping((prev) => {
                    const nextSet = new Set(prev);
                    if (nextSet.has(o.id)) nextSet.delete(o.id);
                    else nextSet.add(o.id);
                    return nextSet;
                  })
                }
              />
            ))}
          </div>
          <Button variant="primary" full disabled={keeping.size === 0} onClick={() => finishQ1(false)}>
            Continue
          </Button>
          <button type="button" className="cs-linkbtn" onClick={() => finishQ1(true)}>
            Skip
          </button>
        </>,
      );

    case "q2":
      return card(
        <>
          {dots}
          <h1 className="cs-signin-title">How did you find ColdStorage?</h1>
          <p className="cs-signin-text">Also optional — last question.</p>
          <div className="cs-qrows">
            {FOUND_VIA_OPTIONS.map((o) => (
              <OptionRow key={o.id} label={o.label} selected={foundVia === o.id} onToggle={() => setFoundVia((v) => (v === o.id ? null : o.id))} />
            ))}
          </div>
          <Button variant="primary" full disabled={!foundVia} onClick={() => finishQ2(false)}>
            Continue
          </Button>
          <button type="button" className="cs-linkbtn" onClick={() => finishQ2(true)}>
            Skip
          </button>
        </>,
      );

    case "done": {
      const firstName = (account.displayName ?? name).trim().split(/\s+/)[0] ?? "";
      return card(
        <>
          {dots}
          <Pict icon="check" />
          <h1 className="cs-signin-title">{firstName ? `You're set, ${firstName}` : "You're set"}</h1>
          <p className="cs-signin-text">
            {!subscribed && quotaBytes != null ? (
              <>
                You have <strong>{formatBytes(quotaBytes)} free, forever</strong>. Deposit your first files
                whenever you&apos;re ready — more room is there if you ever need it.
              </>
            ) : (
              <>Deposit your first files whenever you&apos;re ready.</>
            )}
          </p>
          <Button variant="primary" full onClick={finish}>
            Open My Files
          </Button>
        </>,
      );
    }
  }
};
