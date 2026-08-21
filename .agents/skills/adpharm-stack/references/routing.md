# Type-safe routing (generouted) + type-safe search params

Compile-time-checked navigation and URL state. No raw string paths, no manual `URLSearchParams`.

**Read when:** adding routes, navigating/redirecting, or reading/writing query params.

## Routing

### Contract
- **Foundation:** `app/routes.ts` = `flatRoutes()` from `@react-router/fs-routes` is what turns the `routes/` file tree into RR routes. generouted sits *on top* as a type layer — it does not replace this.
- The generouted generator emits `app/lib/router/routes.ts` — a **different file** from the `app/routes.ts` config above — exposing a typed `Path` union + `Params` map and typed `Link`/`NavLink`/`useNavigate`/`useParams`/`redirect`/`generatePath`.
- Every navigation is compile-checked; an unknown path or wrong param is a type error.

### Non-negotiables
| key | rule | why |
| --- | --- | --- |
| fs-routes-foundation | `app/routes.ts` exports `flatRoutes()` from `@react-router/fs-routes`; the `routes/` tree only becomes routes through it | generouted is just the type layer on top — without this there are no routes |
| generated-types | `app/lib/router/routes.ts` (the generouted type file, distinct from `app/routes.ts`) is generated (`task generate`), never hand-edited | regen scans `routes/`; manual edits get clobbered |
| typed-nav-only | navigate only via the generated wrappers — never `<a href>`/string paths | makes wrong URLs unrepresentable (constraining) |
| file-naming | `$param`→`:param`, `.`→`/`, `(_grp)`=layout/group, `($lang)`=i18n segment | the generator depends on this exact convention |
| implicit-nesting | before naming any new route file whose dot-path has more than one segment, check for an existing route file matching the leading segment(s) — it's the **parent**, and the new file nests under it whether you intended that or not. Its loader runs first, on every request to the child path. If nesting isn't intended, opt out with a trailing `_` on the parent segment (e.g. `auth.google_.callback.tsx`, not `auth.google.callback.tsx`) — URL is unchanged, nesting is broken | any parent loader that redirects or short-circuits (an OAuth kickoff step, a wizard/checkout step, an auth guard) fires before the child ever runs — no error, the child silently never executes, and it's easy to miss since nothing throws |
| i18n-paths | path building respects the en-unprefixed / `/fr` rule | owned by `references/i18n.md`; don't concat `/fr` by hand |
| normalized-url | inside a loader or action, take the app's URL from the `url` argument React Router passes — **never** `new URL(request.url)`. That includes search params: parse `url.searchParams`. A helper that needs the path takes `url: URL` as a required parameter rather than re-deriving one | the raw request carries React Router's own plumbing — a `.data` suffix and `index`/`_routes` params — on every client-side navigation and fetcher submit. A path built from it is right on a hard refresh and wrong the moment the user navigates in-app; nothing throws, you just store or redirect to a URL that renders nothing |

## Search params

### Contract
- A zod schema is the single source of truth for query-param shape + types.
- `parseSearchParams`/`stringifySearchParams` round-trip losslessly (arrays survive); `useSearchParams()` exposes typed read + update helpers.

### Non-negotiables
| key | rule | why |
| --- | --- | --- |
| schema-ssot | one zod schema defines params (`SearchParams = z.infer<…>`); read the parsed object, not `.get("x")` | typed, validated access |
| lossless-roundtrip | (de)serialize only via the parse/stringify pair; arrays survive | URL state stays type-correct |
| hook-api | mutate via `updateSearchParams(partial)` (merges, drops null) / `toggleSearchParam(key,val)` | don't mutate the URL directly |

## Errors

### Contract
- `serverError(status, msg?)` returns a `data()` payload you **throw** from middleware/loaders; it lands in the nearest `ErrorBoundary`. `msg` is user-facing copy, not a log line.
- The boundary reads it back with `authoredErrorMessage(error.data)` (shared, not `.server.ts`) → the authored string, or `null` when nobody wrote one and the screen must use its own copy from `HTTP_STATUS_TEXT`.

### Non-negotiables
| key | rule | why |
| --- | --- | --- |
| throw-by-listener | middleware/loaders throw `serverError(404, "…")` (a Response); action handlers throw `ReadableError` | different listeners: the page IS the answer, so a loader failure needs a real status for caches/crawlers and lands in the boundary; an action failure left the page alive and `useAction` turns it into a toast. Backwards is not cosmetic — a `ReadableError` thrown from middleware renders a **500 "An unexpected error occurred"** with the real reason suppressed in prod |
| real-error-boundary | a scaffolded app ships its own root `ErrorBoundary`, never React Router's template one | the template's is a bare unstyled `<h1>404</h1>` with no way out; shipping it is shipping a dead end |
| copy-in-body-not-statustext | user-facing copy travels in the error **body** (`data({ message }, { status })`), **never** in `Response.statusText` | `statusText` is a ByteString — Node's `Response` throws a `TypeError` on any character above U+00FF (em dash, curly apostrophe) or a newline, so the message throws *inside the loader* and the user gets a 500 instead of the 404 you authored. Bun's `Response` accepts all of it, so it passes every local test and fails only on Vercel. A newline there is also response-splitting the moment a name is interpolated in |
| status-copy-ssot | one function maps status → copy, used by the boundary **and** the root `meta` export (`MetaArgs` includes `error`) | the failing route's own `meta` never runs, so without this the tab title and the page disagree |
| errors-have-an-exit | every error state renders a way out (home, back, the parent resource) | a 404 with no links is a dead end |
| catch-all-404 | ship `app/routes/$.tsx` whose loader just `throw serverError(404)` | unmatched URLs take the same path as every other 404 instead of the framework default. The generouted generator drops paths ending in `/:`, so the splat never enters the typed `Path` union — nothing can `<Link to>` it, correct for a status rather than a place |
| dev-detail-once | the dev-only diagnostic (stack/message) lives INSIDE the shared error screen, guarded once by `import.meta.env.DEV` | re-writing it per call site is how internals leak; the single guard is statically replaced, so the branch is dead-code-eliminated from the prod bundle |
| boundary-replaces-layout | an `ErrorBoundary` on a layout route replaces that layout's **own element** — header and footer included. To keep the chrome, factor the shell into a component the boundary renders too | otherwise "add a boundary to keep the nav" silently deletes the nav |

## Engine — copy faithfully
- Routing: `assets/lib/router/{generouted-components.tsx, generouted-generate-routes.ts, router-utils.ts, server-responses.server.ts, http-status.ts}` (+ `http-status.test.ts` — the `serverError`↔`authoredErrorMessage` contract spans two files that never import each other; run it with `task test`). `task generate` produces `app/lib/router/routes.ts` (per-project; never hand-edit). Also wire the RR route config — `app/routes.ts` = `export default flatRoutes() satisfies RouteConfig` (from `@react-router/fs-routes` + `@react-router/dev/routes`) — required boilerplate, not generouted output.
- Search params: `assets/hooks/use-search-params.ts` + `assets/lib/search-params-utils.ts` + `assets/lib/search-params.defaults.ts` (the schema — **edit this per app**) + `assets/lib/types/type-utils.ts`.

Placement + deps: SKILL.md. Adjust only if a current dep API forces it.

## Shape — write fresh (illustration, not gospel)
```ts
// routes/(_app).t.$teamSlug.jobs.tsx  → "/t/:teamSlug/jobs"
<Link to="/t/:teamSlug/jobs" params={{ teamSlug }}>Jobs</Link>
throw redirect("/login");                 // in a loader/action
// per-app schema in search-params.defaults.ts
export const searchParamsSchema = z.object({ filters: z.array(z.string()).optional() });
const { searchParamsObj, updateSearchParams, toggleSearchParam } = useSearchParams();
```

## Verify at latest
- **react-router** — `useNavigate`/`useParams`/`redirect`/`Link` + `setSearchParams`; and `data()`'s return shape (`.data`, `.init.status`), which `http-status.test.ts` asserts against directly.
- **@react-router/fs-routes** + **@react-router/dev** — the `flatRoutes()` foundation + `RouteConfig` type (install both at latest).
- **generouted approach** — confirm the project's current route-type generation; if a better-maintained RR type-safe routing approach is now standard, evaluate it but keep generated-types + typed-wrappers + no-raw-paths.
- **zod**, and the generator's `prettier`/`glob` deps.
