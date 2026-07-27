/**
 * Toasts — the app's channel for things that happened but have no other visible surface.
 *
 * There was one before this, and it only ever said what went WRONG: a single fixed div in `App`, driven
 * off the latest error string, dismissed by remembering which message the user had already waved away.
 * So every failure announced itself and every success was silent — start a transfer and the app said
 * nothing at all, leaving you to go and check the Transfers page to find out whether the thing you just
 * clicked had worked. Invisible work the user has no way to see is exactly what we owe a message (CORE9),
 * and "it worked" is invisible work too.
 *
 * The rules that fall out of that:
 *   - **Successes expire, errors don't.** A confirmation has done its job in a few seconds; a failure is
 *     something the user may need to read twice, or copy, so it waits to be dismissed.
 *   - **They stack.** Deposit two folders and both confirmations should be readable — the single-slot
 *     version silently replaced whichever came first.
 *   - **Identical messages collapse.** The daemon can re-report the same live error, and the same
 *     completion can arrive twice across a reconnect; neither deserves a second toast.
 *
 * Errors keep the shape they had (red surface, an optional inline recovery action, a close button), so
 * nothing about how a failure reads changes here.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Icon, IconButton } from "./primitives.tsx";

export type ToastTone = "success" | "error" | "info";

/** An inline button on the toast — the one thing to do about what it just said ("Show in Finder"). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  action?: ToastAction;
}

/** How long a self-dismissing toast stays. Long enough to read a sentence and reach the action on it. */
const LINGER_MS = 6_000;

const ICON: Record<ToastTone, string> = {
  success: "check_circle",
  error: "error",
  info: "info",
};

interface ToastApi {
  /** Post a toast. Returns its id (so a caller can retract one it owns); a duplicate of a toast already
   * on screen returns the existing id and adds nothing. */
  show: (tone: ToastTone, message: string, action?: ToastAction) => number;
  /** Sugar for the common case. */
  success: (message: string, action?: ToastAction) => number;
  error: (message: string, action?: ToastAction) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * The toast channel + the stack that renders it. Wraps the whole app (see `main.tsx`), because a toast
 * outlives the view that raised it — a transfer confirmation must survive the user navigating away from
 * My Files the instant they click Start.
 */
export const ToastProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  // Timers are cleared on unmount so a pending dismissal can't fire into an unmounted tree.
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  // The live list, mirrored in a ref. Two things need it to be readable SYNCHRONOUSLY, and neither can be
  // served by `toasts` (a render-time snapshot) or by a `setToasts` updater (which runs later, so `show`
  // would have returned already):
  //   - dedup, when several shows land in one tick (a batch of transfers all completing at once) — every
  //     one of them would otherwise read the same stale list and add a duplicate, and
  //   - the id `show` hands back, which has to be the real one at the moment it returns.
  const listRef = useRef<Toast[]>([]);

  const commit = useCallback((next: Toast[]): void => {
    listRef.current = next;
    setToasts(next);
  }, []);

  const dismiss = useCallback(
    (id: number): void => {
      const t = timers.current.get(id);
      if (t !== undefined) {
        clearTimeout(t);
        timers.current.delete(id);
      }
      commit(listRef.current.filter((x) => x.id !== id));
    },
    [commit],
  );

  const show = useCallback(
    (tone: ToastTone, message: string, action?: ToastAction): number => {
      const existing = listRef.current.find((t) => t.tone === tone && t.message === message);
      if (existing) return existing.id;
      const id = nextId.current++;
      // Built by branch, not `{ ...rest, action }`: under `exactOptionalPropertyTypes` an explicit
      // `action: undefined` is not the same as an absent key, and only the absent one is a `Toast`.
      commit([...listRef.current, action ? { id, tone, message, action } : { id, tone, message }]);
      return id;
    },
    [commit],
  );

  // Arming the expiry as an effect rather than inside `show` keeps it honest under React 19's StrictMode
  // double-invoke (a timer set during render's commit phase would be armed twice) and means a toast that
  // was deduped away doesn't get a second timer.
  useEffect(() => {
    for (const t of toasts) {
      if (t.tone === "error" || timers.current.has(t.id)) continue;
      timers.current.set(
        t.id,
        setTimeout(() => dismiss(t.id), LINGER_MS),
      );
    }
  }, [toasts, dismiss]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (message, action) => show("success", message, action),
      error: (message, action) => show("error", message, action),
      dismiss,
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="cs-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`cs-toast cs-toast--${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
            <Icon name={ICON[t.tone]} size={20} />
            <span className="cs-toast-msg">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="cs-toast-action"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <IconButton icon="close" label="Dismiss" onClick={() => dismiss(t.id)} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

/** The toast channel. Throws outside the provider rather than no-opping — a swallowed confirmation is
 * the bug this whole file exists to fix, so it should fail loudly in development. */
export const useToast = (): ToastApi => {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside a <ToastProvider>");
  return api;
};
