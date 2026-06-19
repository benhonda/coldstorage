# AI / LLM calls — Vercel AI Gateway (keyless)

How the app calls models. **Owns the AI-provider facts** other references link to. This
file is the **Adpharm convention** (keyless, no provider keys); for deep gateway mechanics
— model routing, provider failover, BYOK, cost tracking — defer to the **`ai-gateway`**
sibling skill (invoke with the Skill tool; vendored in this registry, add via `npx skills add`).

**Read when:** adding any LLM/AI feature — text generation, streaming, tool-calling, embeddings.

## Contract
- All model calls go through **Vercel AI Gateway**, via the `ai` package (AI SDK). The
  gateway is the AI SDK's **default provider**, so a plain `creator/model` string routes
  through it — one account, every provider, **no provider API keys in the app**.
- **Keyless by OIDC**, exactly like AWS (see `aws-oidc.md`): on Vercel the gateway
  authenticates with the auto-injected `VERCEL_OIDC_TOKEN` — nothing to set, store, or
  rotate. Locally, `vercel env pull` provisions the token (12h expiry; `vercel dev`
  auto-refreshes).
- Server-side only — call from `.server.ts`, actions, or resource routes
  (`references/data-fetching.md`), never the client.

## Non-negotiables
| key | rule | why |
| --- | --- | --- |
| gateway-default | call models via the `ai` package's default gateway provider — plain `"creator/model"` strings (e.g. `"anthropic/claude-opus-4-8"`); no `@ai-sdk/openai` etc. provider packages | one keyless account fronts every provider |
| keyless-oidc | rely on `VERCEL_OIDC_TOKEN` (auto in prod, `vercel env pull` locally) — **do NOT set `AI_GATEWAY_API_KEY`**: a present key always wins over OIDC and defeats keyless | matches the stack's no-stored-secrets OIDC posture |
| no-env-entry | the gateway needs no app env var, so it does **not** go in the zod env schema (`references/env.md`) — OIDC is ambient | nothing to validate; adding one invites a stored key |
| claude-default | default to the latest Claude model; confirm the current id via the `claude-api` skill, then prefix `anthropic/` | team default + CLAUDE.md |

## Engine
None — Shape (the AI SDK is the machinery; we just call it).

## Shape — write fresh (illustration, not gospel)
```ts
// lib/ai/summarize.server.ts
import { generateText } from "ai";

export async function summarize(input: string) {
  const { text } = await generateText({
    model: "anthropic/claude-opus-4-8", // gateway default provider — no key, no import
    prompt: `Summarize:\n\n${input}`,
  });
  return text;
}
```
Streaming, tools, and embeddings are the same call shape (`streamText`, `tools`, `embed`)
— only the model string and options change.

## Verify at latest
- **`ai` package** — current `generateText`/`streamText`/tool-calling API and that the
  gateway is still the default provider for bare `creator/model` strings.
- **Vercel AI Gateway OIDC** — current keyless setup + local `vercel env pull` flow and
  token TTL; this integration evolves.
- **Model id** — current Claude id via the `claude-api` skill (don't trust memory).
