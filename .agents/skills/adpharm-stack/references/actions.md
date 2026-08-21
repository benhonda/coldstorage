# Server actions (writes only)

A typed pipeline from a client call to a server handler and back, for **writes (mutations)**. Reads do **not** go here — see `references/data-fetching.md`.

**Read when:** adding a mutation, wiring a form submit, or any "write something" call.

## Contract
- `useAction(definition)` → `{ submit, data, error, isSubmitting }`, fully typed from the definition.
- `submit(input)` POSTs JSON to the **current route's** action; that action is the one shared dispatcher (`action_handler`), which looks the action up in a generated map by directory name and runs the matching server handler.
- The handler gets zod-validated input and returns a value whose type flows back to `data`. Errors return as `{ message_unsafe, message_safe }`, never an unhandled throw.
- After a successful write, RR auto-revalidates loaders; refresh SWR-cached reads via `mutate()` from `onSuccess` (see `references/data-fetching.md`).
- `useOptimisticAction(definition, serverValue, toInput)` → `{ value, set, pending, error }` for **instant-effect** controls (a Switch, a Hide/Show menu item, a star). Render `value`, call `set(next)`: the control moves now, the write follows, a failure snaps it back. See `pending-is-visible`.

## Non-negotiables
| key | rule | why |
| --- | --- | --- |
| writes-only | actions are for writes/mutations only — no `type:"query"` reads, no client cache here | reads are loaders or useSWR (`references/data-fetching.md`); keeps the action engine small |
| two-file-action | each action = `lib/actions/<name>/action-definition.ts` + `action-handler.server.ts`, co-located | everything about one action in one place (local, self-teaching) |
| dir-name-matches | the directory name equals the definition's `actionDirectoryName` | the filename is the contract; the generator keys off it |
| generated-map | the action map is generated, never hand-edited (run `task generate`) | regen scans the handler files, so the map can't drift from what's on disk. Know the limit though: it emits `Record<string, any>` and `useAction` isn't constrained to `ActionName`, so a definition whose handler file is missing still compiles and fails as a runtime 400. The generator keeps the two in sync; the types do not enforce it |
| single-dispatch | one dispatcher *function* (`action_handler`): `useAction` submits to `"."` and every route that hosts actions does `export const action = action_handler`. Do NOT invent a global `/api/action` endpoint or change the submit target | it's one shared *handler*, not one shared *URL* — no per-action API routes, no engine rewrite |
| revalidate-after-write | after success, let RR revalidate loaders automatically; for SWR-cached reads call `mutate(key)` in `onSuccess` | invalidation lives at the call site, not in a bespoke action cache |
| safe-unsafe-errors | handlers throw `ReadableError` (never `serverError` — see `references/routing.md`, `throw-by-listener`); the server normalizes to `{ message_unsafe, message_safe }`: log unsafe, show safe | the page survived and only the write failed, so it belongs in a toast, not an error screen; never leak raw errors, never swallow them |
| dev-loud-guards | keep the hook's dev warnings (e.g. suspected infinite submit loops) | failures surface immediately |
| handler-args | a handler's signature is `(data, request, url)` — `url` is React Router's normalized URL, forwarded by the dispatcher. Any path a handler derives or hands to a helper comes from `url` (`normalized-url` in `references/routing.md`) | a fetcher submits to `<route>.data`, so `request.url` inside a handler is never the page the user is on |
| pending-is-visible | **every** write reports in flight, and the report belongs to the control that started it. Commit-on-press (a Save button) → `loading={isSubmitting}` on the DS Button (`references/components.md`). Instant-effect (a Switch) → `useOptimisticAction`, never `isSubmitting` | a switch that waits for a round trip reads as a broken switch; it stays consistent because it's the hook + the DS component, not per-screen invention |
| repeat-not-intent | the submit guard swallows an **identical** payload fired twice in quick succession; a **different** payload always goes through, and a **failed** write re-arms the guard immediately | it must catch the double-click without dropping a toggle flicked off and straight back on — or, once a write fails, without eating the user's retry of the very same value, which is the likeliest next click |
| swallowed-submit-is-visible | `submit` returns `false` when it swallows a duplicate. Anything that moves UI ahead of the write must gate on that return (`useOptimisticAction` only takes its override if `submit` returned `true`) | a swallowed submit fires no `onSuccess` and no `onError`, so an optimistic override set regardless is never cleared — the control sits showing a value the server never received, with no pending state and no error to explain it |
| one-hook-one-write-in-flight | a hook instance owns one fetcher, and submitting again on it aborts the previous request — only the **last** result reaches the result effect. So one hook instance shared across many rows (a board, a list) must settle optimistic state against **loader truth**, never against a per-write callback arriving for every write it fired | the callbacks genuinely don't all arrive, and there is no knob to change that: `SubmitOptions` carries no `AbortSignal`, so hand-rolling an `AbortController` here does nothing — TypeScript won't even flag the dead `signal`, because a property spread into an options object skips excess-property checking. Give a row its own hook instance, or reconcile against the loader |

## Engine — copy faithfully (`assets/lib/actions/_core/*`, `assets/hooks/use-action.ts`)
`action-utils(.ts/.server.ts)`, `action-runner.server.ts`, `action-map.generate.ts`, and the `use-action` hook. `task generate` produces the imported `action-map.ts` (per-project; never hand-edit). Placement + deps: see SKILL.md; pipeline: `references/taskfile.md`. Adjust only if a current dep API forces it.

## Shape — write fresh per action (illustration, not gospel)
```ts
// action-definition.ts — output type via phantom generic
export const updateProfile = defineAction<{ ok: true }>()({
  actionDirectoryName: "update-profile",
  inputDataSchema: z.object({ name: z.string().min(1) }),
});
// action-handler.server.ts — default export, typed in/out
export default createActionHandler(updateProfile, async ({ inputData }, request, url) => {
  await requireAdminUser(request, url);   // auth helpers take the normalized url, not request.url
  const { name } = parseActionInput(updateProfile, inputData);
  if (taken(name)) {
    // payloadError takes the DIRECTORY NAME (a string) + an error — not the
    // definition object. A ReadableError's message becomes `message_safe`;
    // anything else is logged as unsafe and the user sees a generic message.
    return payloadError("update-profile", new ReadableError(`"${name}" is already taken.`));
  }
  // ...write to the DB...
  return { ok: true } as const;
});
// component — commit-on-press: pending lives on the button
const { submit, data, error, isSubmitting } = useAction(updateProfile, {
  toastOnSuccess: { message: "Saved" },
  onSuccess: () => mutate("/api/profile"),  // refresh the SWR read, if any (loaders auto-revalidate)
});
<Button type="submit" loading={isSubmitting} loadingLabel="Saving…">Save</Button>

// component — instant-effect: the control moves first, the write follows
const hidden = useOptimisticAction(updateProfile, member.hidden, (hidden) => ({ id: member.id, hidden }));
<Switch checked={hidden.value} onCheckedChange={hidden.set} />

// wiring: each route that hosts actions re-exports the one dispatcher as its action.
// app/routes/(_app).tsx
import { action_handler } from "~/lib/actions/_core/action-runner.server";
export const action = action_handler;   // useAction submits to "." → hits this
// GOTCHA: from an INDEX route, "." appends ?index and resolves to the index route
// itself — NOT the parent layout. An index route hosting useAction must export the
// dispatcher itself; the layout's action does not cover it.
```
Forms use this + RR native form handling — there is no form generator (see SKILL.md).

## Verify at latest
- **zod** — `infer` + current top-level helpers (e.g. `z.email()` vs `z.string().email()`).
- **react-router** — `ActionFunctionArgs`, `useFetcher` JSON submit, redirect/`Response`. Confirm `fetcher.submit` is still referentially stable: it's a dep of the hook's `submit` callback, so if it churns per render `submit` does too, and a `useEffect(…, [submit])` call site turns into the infinite loop `dev-loud-guards` warns about.
- **sonner** — current toast API.
