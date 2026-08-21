import {
  useFetcher,
  useNavigate,
  type FetcherSubmitOptions,
  type SubmitTarget,
} from "react-router";
import type {
  ActionHandlerReturnType,
  ActionPayloadError,
  ActionDefinition,
  ActionDefinitionData,
} from "~/lib/actions/_core/action-utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { logError } from "~/lib/logger";
import { toast } from "sonner";

/**
 * How long an IDENTICAL payload is treated as an accidental repeat (double-click,
 * held key) rather than a second intent.
 */
const DUPLICATE_SUBMIT_WINDOW_MS = 500;

/**
 * Track action call frequency to detect performance issues (dev only).
 */
const actionCallTracker = new Map<string, number[]>();

function trackActionCall(actionName: string) {
  if (!import.meta.env.DEV) return;
  const now = Date.now();
  const recent = (actionCallTracker.get(actionName) || []).filter(
    (t) => now - t < 5000,
  );
  recent.push(now);
  actionCallTracker.set(actionName, recent);
  if (recent.length >= 5) {
    console.warn(
      `⚠️ Performance: "${actionName}" called ${recent.length}x in 5s`,
      recent,
    );
  }
}

/**
 * Submit a WRITE (mutation) to its server handler via the shared dispatcher.
 *
 * Actions are write-only. For reads use a loader (SSR) or useSWR + a resource route
 * (client) — see references/data-fetching.md. After a successful write, React Router
 * automatically revalidates loaders; to refresh SWR-cached reads, call SWR's
 * `mutate(key)` from `onSuccess`.
 */
export type UseActionExtra<T extends ActionDefinition> = {
  /** Route to submit to. Defaults to "." (current route, whose `action` is `action_handler`). */
  route?: string;
  onSuccess?: (data: ActionDefinitionData<T>["outputData"]) => void;
  onSuccessRedirectTo?: (data: ActionDefinitionData<T>["outputData"]) => string;
  onError?: (error: ActionPayloadError) => void;
  toastOnSuccess?: { message: string };
  toastOnError?: { message?: string };
};

export function useAction<T extends ActionDefinition>(
  actionDefinition: T,
  extra?: UseActionExtra<T>,
) {
  type ADD = ActionDefinitionData<T>;

  // Dedupe: track the last handled result id.
  const actionIdRef = useRef<string | null>(null);
  // Detect submit() called during render (infinite loop) in dev.
  const renderCallCountRef = useRef(0);
  // Last payload submitted, for the accidental-repeat guard below.
  const lastSubmitRef = useRef<{ key: string; at: number } | null>(null);

  const [actionData, setActionData] = useState<
    ActionHandlerReturnType<ADD> | undefined
  >(undefined);
  const [actionState, setActionState] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");

  // Always use a fetcher so writes don't block route navigation.
  const nativeFetcher = useFetcher();
  const fetcherData = nativeFetcher.data as
    | ActionHandlerReturnType<ADD>
    | undefined;
  const nativeNavigate = useNavigate();

  // Reset the render-call counter each render.
  useEffect(() => {
    renderCallCountRef.current = 0;
  });

  const handleSuccess = useCallback(
    (data: ADD["outputData"]) => {
      extra?.onSuccess?.(data);
      setActionState("success");
      if (extra?.toastOnSuccess) toast.success(extra.toastOnSuccess.message);
      if (extra?.onSuccessRedirectTo) {
        const redirectTo = extra.onSuccessRedirectTo(data);
        if (!redirectTo) {
          toast.error("No redirect to provided");
          return;
        }
        nativeNavigate(redirectTo);
      }
    },
    [extra, nativeNavigate],
  );

  const handleError = useCallback(
    (error: ActionPayloadError) => {
      // A failed write re-arms the duplicate guard: the next identical payload is a
      // RETRY, not a bounce. Without this, a user correcting a fast failure by
      // re-clicking the same control inside the window gets silently swallowed.
      lastSubmitRef.current = null;
      extra?.onError?.(error);
      setActionState("error");
      // Users see the SAFE message (ReadableError detail, or a generic fallback) —
      // message_unsafe can carry internals (zod issues, raw DB errors) and only
      // belongs in the console.
      console.error("Action error:", error.message_unsafe);
      toast.error(extra?.toastOnError?.message ?? error.message_safe);
    },
    [extra],
  );

  // Handle each fetcher result exactly once — but only after the fetcher has fully
  // settled. A fetcher.submit() kicks off an automatic loader revalidation; firing
  // success side-effects (toast + navigate) while that revalidation is still in
  // flight races it — a client navigate() issued mid-"loading" is intermittently
  // dropped by the completing revalidation. Waiting for "idle" makes it deterministic.
  useEffect(() => {
    if (nativeFetcher.state !== "idle") return;
    const result = fetcherData;
    if (!result?._id) return;
    if (actionIdRef.current === result._id) return; // already handled
    actionIdRef.current = result._id;

    // Result is for a different action instance — ignore.
    if (result.currentAction !== actionDefinition.actionDirectoryName) return;

    // Unwrap the nested data keyed by action name.
    const extracted = result.data?.[
      actionDefinition.actionDirectoryName as keyof typeof result.data
    ] as ADD["outputData"];

    setActionData({
      ...result,
      data: extracted,
    } as ActionHandlerReturnType<ADD>);

    if (import.meta.env.DEV) {
      console.log(`[Action:${actionDefinition.actionDirectoryName}]`, {
        success: result.success,
        data: extracted,
      });
    }

    if (result.success) {
      handleSuccess(extracted);
      return;
    }
    if (result.error) {
      handleError(result.error);
      return;
    }
    logError("useAction: unknown action state", { result });
    setActionState("error");
  }, [
    fetcherData,
    actionDefinition.actionDirectoryName,
    handleError,
    handleSuccess,
  ]);

  // Submit the write, swallowing an accidental repeat.
  const submit = useCallback(
    /**
     * Returns TRUE when the write was dispatched, FALSE when it was swallowed as a
     * duplicate. Callers that move UI before the write lands must check it —
     * a swallowed submit produces no onSuccess and no onError, so anything waiting
     * on one of those to clean up would wait forever (see useOptimisticAction).
     */
    (
      inputData: ADD["inputData"],
      // FetcherSubmitOptions, NOT SubmitOptions: this hook always writes through a
      // fetcher, and fetcher.submit ignores the navigation-only options
      // (replace/state/navigate/fetcherKey/viewTransition). Typing the wider set
      // here would advertise five knobs that silently do nothing.
      submitOptions: FetcherSubmitOptions = {},
    ): boolean => {
      try {
        const actionName = actionDefinition.actionDirectoryName;

        // Guard the double-click, not the second intent: only an IDENTICAL
        // payload fired again inside the window is swallowed. A plain time
        // window would also eat a toggle flicked off and straight back on,
        // leaving the server on the first value while the UI showed the second.
        const key = JSON.stringify(inputData ?? null);
        const now = Date.now();
        const last = lastSubmitRef.current;
        if (
          last &&
          last.key === key &&
          now - last.at < DUPLICATE_SUBMIT_WINDOW_MS
        ) {
          return false;
        }
        lastSubmitRef.current = { key, at: now };

        if (import.meta.env.DEV) {
          renderCallCountRef.current++;
          if (renderCallCountRef.current > 1) {
            console.error(
              `⚠️ INFINITE LOOP DETECTED: ${actionName}.submit() called during render.\n` +
                `Move the submit() call inside useEffect or an event handler.`,
            );
          }
        }

        trackActionCall(actionName);

        setActionState("submitting");

        // There is no request-cancellation knob to reach for here, and none is
        // needed: SubmitOptions carries no AbortSignal, and the router already
        // aborts a fetcher's in-flight request when the same fetcher submits
        // again. So only the LATEST result reaches the result effect — which is
        // why anything sharing one hook instance across many rows (a board, a
        // list) must settle optimistic state against loader truth rather than
        // trusting a per-write callback to arrive for every write it fired.
        const options = {
          ...submitOptions,
          method: "post" as const,
          encType: "application/json" as const,
        };

        // SubmitTarget's JSON-payload variant is JsonValue, which a generic
        // inputData can't be proven to satisfy; the cast aligns the runtime shape
        // with what fetcher.submit accepts under encType application/json.
        // (PILLAR4: one narrow named cast, never `as any`.)
        const payload = {
          actionDirectoryName: actionName,
          inputData,
        } as SubmitTarget;

        // Submit to "." — the current route, whose `action` export is the shared
        // `action_handler` dispatcher. Override via extra.route only for a non-current target.
        //
        // fetcher.submit returns a Promise; this function is synchronous (it returns
        // dispatched-or-swallowed), so a rejection can only be caught off the promise.
        // Left floating it would surface as an unhandled rejection and the write would
        // fail with no pending state ever clearing and nothing shown (PILLAR5).
        void nativeFetcher
          .submit(payload, { ...options, action: extra?.route ?? "." })
          .catch((error) => {
            console.error("Error submitting action:", error);
            setActionState("error");
          });
        return true;
      } catch (error) {
        // Only synchronous failures land here — a payload that can't be serialized
        // for the duplicate-guard key, say. The submission's own failure path is the
        // .catch above.
        console.error("Error submitting action:", error);
        setActionState("error");
        // Nothing was dispatched, so no result callback is coming.
        return false;
      }
    },
    [actionDefinition.actionDirectoryName, extra?.route, nativeFetcher.submit],
  );

  return {
    submit,
    data: actionData?.data,
    error: actionData?.error,
    isSubmitting: actionState === "submitting",
  };
}

/**
 * Bind an INSTANT-EFFECT control (a Switch, a Hide/Show menu item, a star) to a
 * write, so the control moves on the click instead of a round-trip later.
 *
 * `value` is the server's value until you `set()` a new one — then it's YOURS
 * until the write settles. That handover is flicker-free: useAction only reports
 * a result once its fetcher is fully idle, and a fetcher only reaches idle after
 * the loader revalidation it kicked off has landed, so the server value is
 * already the new one by the time the override drops. A FAILED write drops the
 * override too, snapping the control back to the truth while useAction's toast
 * says why.
 *
 * Not for controls that commit on a separate Save press — those hold plain
 * useState and show their pending state on the Save button (`loading` on
 * <Button/>).
 */
export function useOptimisticAction<T extends ActionDefinition, TValue>(
  actionDefinition: T,
  /** The value as the server currently knows it — i.e. straight off loader data. */
  serverValue: TValue,
  /** Builds the write's payload from the value the user just chose. */
  toInput: (value: TValue) => ActionDefinitionData<T>["inputData"],
  extra?: UseActionExtra<T>,
) {
  // null = "no local opinion, show the server's value".
  const [override, setOverride] = useState<{ value: TValue } | null>(null);

  // Memoized: useAction's result effect depends on these callbacks, so a fresh
  // object each render would re-run it every render — a loop hazard sitting right
  // next to the one dev-loud-guards warns about.
  const wrappedExtra = useMemo(
    () => ({
      ...extra,
      onSuccess: (data: ActionDefinitionData<T>["outputData"]) => {
        setOverride(null);
        extra?.onSuccess?.(data);
      },
      onError: (error: ActionPayloadError) => {
        setOverride(null);
        extra?.onError?.(error);
      },
    }),
    [extra],
  );

  const action = useAction(actionDefinition, wrappedExtra);

  return {
    /** What the control should render right now. */
    value: override ? override.value : serverValue,
    /** Start the write and move the control — both in this handler, so the user
     *  still sees the control move on the same frame as the click. */
    set: (value: TValue) => {
      // Only take a local opinion if a write actually went out. A swallowed
      // duplicate produces no result callback, so an override set here would
      // never be cleared — the control would sit showing a value the server
      // never got, with no pending state and no error, until a reload.
      if (action.submit(toInput(value))) setOverride({ value });
    },
    /** True while the write is in flight — the control has ALREADY moved, so use
     *  this only for extra chrome, never to gate the UI. */
    pending: action.isSubmitting,
    error: action.error,
  };
}
