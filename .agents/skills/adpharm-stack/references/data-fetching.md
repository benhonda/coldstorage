# Reading data — loaders vs useSWR (writes → actions)

How to **read/list** data. SSR-first as the baseline, but client loading with `useSWR` + a dedicated resource route is a first-class path, not an exception. Writes never go here — they use `references/actions.md`.

**Read when:** fetching or listing data for a page or component — or making a read's latency honest on screen (pending, prefetch, streaming).

## Contract
- Three lanes, chosen by *what the data needs* (not just speed):
  - **Server HTML (SEO / shareable / above-the-fold / critical) → RR `loader`.**
  - **Client-interactive / non-critical / live / post-mount → `useSWR` + a resource route.**
  - **Any write → the action framework.**
- "API routes" here means **RR resource routes** (a route module with a `loader`, no default export) returning JSON, consumed by SWR.

## Non-negotiables
| key | rule | why |
| --- | --- | --- |
| ssr-data-loader | data that must be in the server HTML (SEO, shareable, critical/above-the-fold) is fetched in a route `loader` | SSR'd, no client waterfall, auto-revalidated after writes |
| slow-stream | if a loader is slow, stream it — **return the promise itself** from the loader and render it through `<Await>` inside `<Suspense>`. Don't drop to client fetch just because it's slow, and don't reach for `defer()`: it no longer exists | keeps SSR; "slow" is not the trigger to abandon it. `defer` was removed in React Router 8 — code carrying it doesn't fail typecheck in every setup, it fails at runtime as "not a function" |
| named-fallback | a streamed section's `<Suspense fallback>` names what it's waiting on — one placeholder per row that's coming ("Checking DocuSign…"), labels read from the same constants the resolved rows use, never re-typed | a grey bar says "wait"; a named row says what for, and *which* dependency is slow is usually the most useful thing on screen. Re-typed labels drift: the tell is a placeholder handing over to a differently-named row — one check looking like two |
| nav-pending-is-visible | a blocking navigation reports in flight **on the control that started it**. Link or tab → `NavLink`'s `isPending`. A button that navigates (`useNavigate`, or a `Link` styled as one) → `useNavigation()` matched to the target (`navigation.location?.pathname === href`), never bare `navigation.state === "loading"` — that state is global and lights every nav control at once. Either way the report is the DS Button's `loading` prop (`references/actions.md`) plus `aria-busy`, not a bespoke spinner. The read-side sibling of `pending-is-visible` | RR blocks the transition until loaders resolve, so the default is a click that does nothing and then jumps. A tab that waits on a round trip reads as a broken tab for exactly the reason a switch does. **It never excuses a slow loader** (`slow-stream`) — a pending state that makes a bad wait tolerable is how the bad wait survives |
| prefetch-intent | primary navigation (tabs, nav links) uses `prefetch="intent"`. Its corollary is a constraint on the loader: **a prefetched route's loader runs on hover, so it must be a pure read** — no stamping a row, minting a token, or firing a billable third-party call | turns most of the loader wait into hover time for free. The corollary is the trap: neither half of the pair is visible from the other, so loaders stay side-effect-free by default |
| client-data-swr | client-interactive / non-critical / live / post-mount data (lists, filters, polling, infinite scroll, dashboards behind auth) → `useSWR` + a resource route | snappy shell, free caching/dedup/revalidation; this is a common path, not a fallback |
| typed-fetcher | SWR reads go through a typed fetcher that shares the resource route's loader return type | reads stay type-safe — don't regress the type-safety pillar |
| resource-route | "API routes" are RR resource routes (loader-only module returning JSON); reuse the same auth/session/env helpers as page loaders | one server-data path, consistent auth |
| writes-not-here | never write through a read path; mutations go through `references/actions.md` | reads and writes are separate by design |

## Engine
None — this is Shape. **Don't build a bespoke read cache**; `useSWR` is a maintained library (install `swr@latest`). Consider TanStack Query only as a deliberate alternative.

## Shape — write fresh (illustration, not gospel)
```ts
// app/routes/api.projects.ts — a resource route (loader only, returns JSON)
export async function loader({ request, url }: LoaderFunctionArgs) {
  await requireUser(request, url);            // same auth helper as page loaders
  return Response.json(await listProjects()); // its return type is the read's contract
}
export type ProjectsResponse = Awaited<ReturnType<typeof loader>>; // share for typing

// app/hooks/use-projects.ts — typed SWR read
import useSWR from "swr";
const fetcher = <T>(url: string) => fetch(url).then((r) => r.json() as Promise<T>);
export const useProjects = () => useSWR("/api/projects", fetcher<Project[]>);

// SSR + live: seed SWR from a page loader so first paint is server-rendered
useSWR("/api/projects", fetcher, { fallbackData: loaderData.projects });
```

## Verify at latest
- **swr** — current `useSWR`/`mutate` API + `fallbackData`. (TanStack Query if chosen.)
- **react-router** — resource-route shape, and `Await`/`useAsyncValue` + `Suspense` for streaming slow loader data, and `NavLink`'s `isPending` render prop, `useNavigation()`'s `state`/`location`, and `prefetch` values.
