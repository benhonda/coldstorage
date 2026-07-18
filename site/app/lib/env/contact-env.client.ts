/**
 * Contact form — client-readable config. Values are served off `window.env` (injected in
 * `app/root.tsx` from `getAllPublicEnv()`); the server schema + validation live in
 * `contact-env.server.ts`. These `@env` markers tell the env-map generator to add the vars
 * to the `Window["env"]` type in `all-client-env.ts`.
 *
 * @env PUBLIC_TURNSTILE_SITE_KEY - Cloudflare Turnstile site key (public half of the widget pair)
 */
export {};
