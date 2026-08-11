# UI components — shadcn on Base UI

Components are **not** custom in this stack — use shadcn defaults. The one convention that matters: the primitive base is **Base UI**, not Radix.

**Read when:** initializing shadcn in a project, or adding/using UI components.

## Contract
- Components come from the current shadcn CLI, built on **Base UI** primitives.
- One shadcn config (`components.json`) pins the base/preset/aliases; `cn` lives at `~/lib/utils`; the theme is written into `app/app.css`.

## Non-negotiables
| key | rule | why |
| --- | --- | --- |
| base-ui | init shadcn with **Base UI** (`--base base`), never the Radix default | the team standard; `components.json` style is `base-vega` |
| config-ssot | `components.json` is the source of truth for the **wiring**: `iconLibrary: lucide`, aliases `~/components` `~/lib/utils` `~/components/ui` `~/lib` `~/hooks`, css `app/app.css`, `tsx: true`, `rsc: false`. The aesthetic values (`style: base-vega`, `baseColor: gray`) are **arbitrary bootstrap placeholders** so `init` runs non-interactively — the project's theme is the styling authority (`references/theming.md`), so drift in them (e.g. a CLI rev emitting `neutral`) is not worth reconciling | reproducible wiring without promoting placeholder aesthetics to doctrine |
| no-fork | don't fork/rewrite generated component source to change how it *looks* — restyle via theme variables | components stay default; theming is owned by `references/theming.md` |
| shared-states-in-the-component | a missing interaction **state** every screen would otherwise hand-roll goes INTO the component, once. The one that always comes up: `loading` on Button — spinner, `disabled`, `aria-busy`, optional `loadingLabel` — wired to `useAction`'s `isSubmitting` (`references/actions.md`, `pending-is-visible`) | the alternative is twenty call sites each inventing its own `{busy ? "Saving…" : "Save"}`, which is how pending states go missing |
| no-custom-variants | no bespoke CVA variant systems (we dropped those) | defaults are the deliberate choice here |

## Engine — copy faithfully (`assets/components.json` → project root)
Drop in `components.json` (Base UI / Vega / gray / lucide / `~/` aliases), then add components with the CLI (e.g. `bunx shadcn@latest add button dialog`). Only `init` reliably creates `~/lib/utils` (`cn`) and writes theme tokens into `app/app.css` — `add` alone may not, so after running `add` verify `~/lib/utils` and the imported deps exist (`@base-ui/react`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`); create/install whatever's missing.

## Init flow (the flags churn — verify, don't trust memory)
The shadcn `init` CLI changes often (e.g. `--base-color` was removed; `--template` / `--base` / `--preset` are current). Always run `bunx shadcn@latest init --help` first to read the current flags, then init with the **React Router template + Base UI base**, matching `components.json` above.

**Run it non-interactively — `--yes` is not enough.** `--yes`/`-y` only skips the *confirmation* prompt; `init` still blocks on the interactive **preset** picker. The fix is to specify every choice so nothing is left to ask: pass `--template`, `--base`, **and** `--preset` explicitly (don't rely on `-d/--defaults` — it forces `--template=next --preset=nova`, the wrong stack). For our `base-vega` config:

```sh
bunx shadcn@latest init --template react-router --base base --preset vega --yes
```

That runs clean in a non-interactive shell — no TTY fight, no handoff to the user. (If a future CLI rev renames the preset, `--help` is the source of truth.) Since `components.json` is already shipped above, `add` is likewise non-interactive: `bunx shadcn@latest add button --yes`.

## Verify at latest
- **shadcn CLI** — current `init`/`add` flags and the exact Base UI base/preset names (run `--help`); confirm the current Base UI package (`@base-ui/react`).
- **lucide-react** — current icon import names.
