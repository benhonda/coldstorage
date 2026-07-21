// electron-builder config (CommonJS so it's unambiguous under bun's node runtime). Packages the
// electron-vite build into a signed **<productName>.app**. Was electron-builder.yml; became code so the
// app's INSTALL IDENTITY (appId / productName / URL scheme) can differ per lane WITHOUT a second switch to
// keep in sync: the identity is whatever `task ui:config:bake` already wrote into build/app-config.json
// (from ui/identity.json, keyed by ENV) — the SAME file the runtime reads — so a staging bundle and its
// runtime can't disagree, and staging installs alongside prod (own .app, own bundle id, own data dir, own
// coldstorage-staging:// scheme). Config targets electron-builder v26 (signing fields top-level under `mac`;
// v27 nests them in `mac.sign`). Build with `task ui:mac:package` (macOS only). Invoked with
// `--config electron-builder.cjs` (see the Taskfile) — not auto-detected, since the default is still .yml.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

// Identity SSOT: prefer the freshly-baked build/app-config.json (written by `ui:config:bake` immediately
// before electron-builder runs in every packaging task), fall back to prod for a bare/unbaked invocation.
// Reading the bake's OUTPUT (not ENV) is deliberate: identity flows ENV → bake → this file AND the runtime,
// so the bundle can never carry a different name/scheme than the app it launches.
const fallback = JSON.parse(readFileSync(join(__dirname, "identity.json"), "utf8")).production;
let identity = fallback;
try {
  const baked = JSON.parse(readFileSync(join(__dirname, "build", "app-config.json"), "utf8"));
  // A cert-less dogfood bake with no infra handoff still writes identity, so these are always present on a
  // real build; guard anyway so a hand-rolled app-config.json can't strip the app of a name.
  if (baked.productName && baked.appId && baked.scheme) identity = baked;
} catch {
  // No baked file (never happens via the Taskfile, which bakes first) → prod identity.
}

module.exports = {
  appId: identity.appId,
  productName: identity.productName,
  copyright: "© 2026 The Adpharm",

  // Deep-link scheme for the OAuth sign-in callback (<scheme>://auth/callback — PROD.md Phase 5).
  // electron-builder writes this into Info.plist CFBundleURLTypes; macOS delivers matching URLs to the
  // running app as `open-url` events (main/index.ts). Packaged-only — dev sign-in uses a loopback redirect.
  // Per-lane so a staging install doesn't fight prod for the coldstorage:// scheme (whoever macOS picks
  // would get the other's sign-in callback); the matching Cognito callback URL is registered in infra.
  protocols: [{ name: identity.productName, schemes: [identity.scheme] }],

  // electron-vite emits the three processes to out/; that + package.json is the whole JS payload (the
  // renderer's deps are already bundled by Vite; main/preload use only `electron` + node builtins).
  directories: {
    buildResources: "build", // icon.icns + entitlements live here (electron-builder convention)
  },
  files: ["out/**", "package.json", "!**/*.map"],

  // The Swift engine + helpers ship INSIDE the bundle (Contents/Resources/bin) and get signed with the app,
  // so a packaged app is self-contained (no dev `.build/release` paths). `coldstored` is the daemon; the
  // others are the helpers the app shells out to (photo picker, restore). NOTE: in step #2 the daemon moves
  // to an SMAppService LaunchDaemon under Contents/Library/LaunchDaemons — at which point its TCC identity
  // becomes the app's. For now it's bundled-but-still-launched the old way; PACKAGING.md tracks the wire-up.
  extraResources: [
    { from: "../coldstorage/.build/release/coldstored", to: "bin/coldstored" },
    { from: "../coldstorage/.build/release/coldstore-photo-picker", to: "bin/coldstore-photo-picker" },
    { from: "../coldstorage/launchd/coldstore-aws-credential-process.sh", to: "bin/coldstore-aws-credential-process.sh" },
    // Baked PUBLIC config (bucket/region/Cognito ids/sign-in domain+client/account-API + the app IDENTITY)
    // — written at package time by `task ui:config:bake` from the infra-outputs handoff (PROD.md Phase 6d),
    // so a config-less customer download self-configures and sign-in is the only setup. NO secret (creds
    // come via Cognito STS). The bake task always writes this file (real values, or identity-only when the
    // handoff is absent for a dogfood build), so electron-builder always finds it here. Read at runtime from
    // Contents/Resources/app-config.json.
    { from: "build/app-config.json", to: "app-config.json" },
  ],

  mac: {
    category: "public.app-category.utilities",
    // 1024px source; electron-builder rasterises every Apple size slot from it (bundled resvg —
    // no iconutil/Xcode needed). Regenerate with `task ui:icon:build`; see ui/scripts/gen-icon.mjs.
    icon: "build/icon.png",
    hardenedRuntime: true, // required for notarization; entitlements below carve out what Electron needs
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    // The bundled Swift Mach-O binaries — sign them explicitly (hardened runtime + inherited entitlements),
    // inside-out, with the same Developer ID as the app. Notarization REJECTS any unsigned binary in the
    // bundle, and TCC keys the Photos grant to `coldstored`'s signature, so this must happen on every build
    // (paths are relative to the .app bundle root). The credential-process .sh is not Mach-O → not listed.
    binaries: ["Contents/Resources/bin/coldstored", "Contents/Resources/bin/coldstore-photo-picker"],
    // The app's own Photos usage string — surfaced when the bundled daemon's grant is requested under the app
    // identity (#2). Harmless before then. (NSPhotoLibraryUsageDescription is Info.plist, not an entitlement.)
    extendInfo: {
      NSPhotoLibraryUsageDescription: "ColdStorage uploads the photos you choose to your private cold storage.",
    },
    // Driven by COLDSTORE_NOTARIZE (was the CLI flag `-c.mac.notarize=true`, which can't coexist with
    // `--config <file>` — the same `-c` key can't be both a path and a nested value). Left false so a plain
    // local `task ui:mac:package` runs unsigned without certs; `task ui:mac:release` sets COLDSTORE_NOTARIZE=true
    // with the Developer ID + notary creds (APPLE_ID / APPLE_TEAM_ID / APPLE_APP_SPECIFIC_PASSWORD) in the env.
    notarize: process.env.COLDSTORE_NOTARIZE === "true",
    target: [
      "dmg", // the human download (from the release page)
      "zip", // REQUIRED by electron-updater on macOS — it applies updates from the .zip
    ],
  },

  dmg: {
    title: identity.productName,
  },

  // Auto-update feed (PROD.md Phase 6). electron-builder uploads the .dmg/.zip + the `latest-mac.yml` metadata
  // to a GitHub Release when built with `--publish always` (see `task ui:mac:release`); the packaged app's
  // electron-updater reads that same feed. Repo is public → the release assets are free, CDN-backed downloads.
  // Keep owner/repo in sync with the root Taskfile's GH_REPO var — the release tasks query and publish to
  // the same repo through `gh`, and a rename here without one there would upload to a different release.
  publish: {
    provider: "github",
    owner: "benhonda",
    repo: "coldstorage",
  },
};
