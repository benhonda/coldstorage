import type { Route } from "./+types/root";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteLoaderData,
} from "react-router";
import { getPreferencesFromRequest } from "~/lib/preferences/preference-cookie.server";
import { getAllPublicEnv } from "~/lib/env/all-server-env";
import { blockingThemeScript } from "~/lib/theme/blocking-theme-script";
import "./app.css";

/**
 * The DS's webfont families, in Google Fonts `css2` query syntax. SSOT for what the site
 * loads — `app/styles/ds/fonts.css` documents what each face is FOR, but carries no URLs,
 * because a second copy of this list is a second thing to forget (PILLAR3).
 *
 * Loaded via <link> rather than a CSS `@import`: a remote @import can't be bundled, and it
 * serialises behind the stylesheet that contains it.
 */
const DS_FONT_FAMILIES = [
  "Outfit:wght@400;500;600;700", // display — headings + wordmark
  "Hanken Grotesk:wght@400;500;600;700", // UI — body, labels, controls
  "JetBrains Mono:wght@400;500;600", // technical — ids, sizes, checksums, paths
  "Material Symbols Rounded:opsz,wght,FILL,GRAD@20..48,300..600,0..1,0", // icons
] as const;

/**
 * One request for every family — `css2` accepts repeated `family` params, so this is a
 * single round trip instead of one per face.
 */
const DS_FONT_HREF = `https://fonts.googleapis.com/css2?${DS_FONT_FAMILIES.map(
  // Spaces become `+`; `: ; @ , .` must stay literal, so no encodeURIComponent here.
  (f) => `family=${f.replace(/ /g, "+")}`,
).join("&")}&display=swap`;

export function loader({ request }: Route.LoaderArgs) {
  const preferences = getPreferencesFromRequest(request);
  // PUBLIC_-prefixed env for the browser, exposed on window.env (see the script in Layout).
  return { preferences, publicEnv: getAllPublicEnv() };
}

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData<typeof loader>("root");
  const theme = data?.preferences?.theme ?? "system";
  const publicEnv = data?.publicEnv ?? {};
  // Explicit light/dark → class on <html>; "system" → empty so the blocking script
  // (which runs pre-paint) sets the resolved class and avoids a flash.
  const htmlClass = theme === "system" ? "" : theme;

  return (
    <html lang="en" className={htmlClass}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Public env for the client (Paddle token, etc.) exposed as window.env. Escape `<`
            so a value can't break out of the <script>. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.env = ${JSON.stringify(publicEnv).replace(/</g, "\\u003c")};`,
          }}
        />
        {/* Blocking, no defer/async — sets the theme class on <html> before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: blockingThemeScript }} />
        {/* Favicons + PWA manifest (RealFaviconGenerator package, served from public/).
            favicon.svg carries BOTH brand variants internally and swaps on the browser
            chrome's prefers-color-scheme — which is why there's no dark-mode twin here.
            .ico is the legacy fallback; the 96px PNG covers browsers without SVG icons. */}
        <link rel="icon" type="image/png" href="/favicon-96x96.png" sizes="96x96" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="shortcut icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        <meta name="apple-mobile-web-app-title" content="ColdStorage" />
        <meta name="theme-color" content="#EDF3F8" />
        {/* ColdStorage DS webfonts — see DS_FONT_FAMILIES. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={DS_FONT_HREF} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details = error.status === 404 ? "The requested page could not be found." : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">{message}</h1>
      <p className="mt-2 text-muted-foreground">{details}</p>
      {stack && (
        <pre className="mt-4 overflow-x-auto rounded-md border border-border p-4 text-sm">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
