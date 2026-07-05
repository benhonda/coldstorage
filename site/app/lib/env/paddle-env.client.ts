/**
 * Paddle — client-readable config. Values are served off `window.env` (injected in
 * `app/root.tsx` from `getAllPublicEnv()`); the server schema + validation live in
 * `paddle-env.server.ts`. These `@env` markers tell the env-map generator to add the
 * vars to the `Window["env"]` type in `all-client-env.ts`.
 *
 * @env PUBLIC_PADDLE_CLIENT_TOKEN - Paddle client-side token (public by design; sandbox/live differ)
 * @env PUBLIC_PADDLE_ENVIRONMENT - Paddle JS environment ("sandbox" | "production")
 */
export {};
