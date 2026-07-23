---
id: 007
title: "Decide: hosted agent architecture"
label: wayfinder:grilling
status: closed
assignee: obarboza
blocked-by: [002]
resolved: 2026-07-22
---

## Question

Design the hosted agent that fronts WhatsApp (and any other channel), as a client of the canonical API:

- LLM provider/model strategy (and cost ceiling per user — feeds pricing).
- Conversation memory model (session vs long-term, what persists).
- Tool set: the agent's tools should map onto the same canonical API operations exposed to third-party agents — confirm or amend.
- Channel-adapter design: WhatsApp adapter shape given the 24h-window/template constraints from 002; how the CLI shares the core.
- Agent runtime approach in TypeScript + Effect-TS (own loop vs SDK).

## Resolution (2026-07-22)

Grilled with obarboza; five decisions locked.

### 1. Runtime: own loop on `@effect/ai`

- **Own agentic loop** built on `@effect/ai` (+ `@effect/ai-openai` provider layer): typed toolkits, provider-agnostic `LanguageModel` layers, streaming/retries/timeouts as Effect primitives. No agent SDK/harness (Claude Agent SDK, Vercel AI SDK, LangGraph/Mastra all rejected — provider lock-in or second-class Effect).
- The loop owns its guards explicitly: max-iteration cap, tool-error feedback to the model, context-window truncation.

### 2. LLM strategy: OpenAI direct, gpt-5.4-nano only

- **Provider: OpenAI direct** — no gateway (OpenRouter considered, rejected over its ~5% fee; the code stays OpenAI-compatible so a gateway remains a one-line escape hatch).
- **Single model for everything: `gpt-5.4-nano`** ($0.20/M input, $1.25/M output; vision, tool calling, structured outputs, prompt caching, 400K context). No escalation tier — weekly insights and long analyses run on nano too; adding a bigger model later is a config change, not a redesign. Named risk: nano-class Spanish conversational tone may feel flat — mitigation is bumping the model id in config.
- **Multimodality**: vision needed (receipt photos, push-notification screenshots per ticket 006); audio NOT needed on-model — Kapso transcribes voice notes before they reach the agent (research 002).
- **Ingestion parsing (006's LLM fallback) rides the same account and model** — structured extraction is nano's stated use case.
- **Cost ceiling (feeds ticket 010): US$1.50/paying user/month hard cap, alert at US$1.00; free tier capped ~US$0.10/user/month.** Expected blended reality ~US$0.20 (heavy user ≈150 turns/mo ≈ US$0.15). Well under the 20–30%-of-ARPU bound from research 004.
- Compliance: OpenAI as US processor is covered by the existing US-cloud-transfer disclosure in the política (ticket 013, already resolved).

### 3. Tool set: strict parity rule, zero private tools

- **Confirmed and hardened**: the hosted agent calls the canonical API *as the user* — user-scoped auth token, same authz path as any third-party agent. In-process transport is fine; the operation contracts are identical.
- **Tool definitions are derived, not hand-written**: each canonical API operation is defined once as an Effect Schema contract; the `@effect/ai` toolkit, HTTP surface, MCP server, and CLI all generate from that single source. Parity cannot drift.
- **New capabilities enter the canonical API first** (dogfooding rule): chart/image rendering becomes a canonical "render widget/query as PNG" endpoint, not a private helper. Media ingestion (receipt photo, screenshot, PDF statement) is a canonical submit-for-extraction operation.
  - *Amended 2026-07-23 by [Decide: tech stack beyond TypeScript + Effect-TS](011-decide-tech-stack.md): the render-as-PNG endpoint is out of MVP — no chart images to WhatsApp; the agent answers in text. The dogfooding rule itself stands.*
- Outside the API: only channel mechanics (session state, message send/receive, WhatsApp formatting) — adapter code, never LLM tools. Messaging/nudges are not tools (ticket 014's domain).

### 4. Memory: three layers + rolling summary live from day one

- **Transcript**: persisted fully in the database, channel-agnostic format (WhatsApp and CLI conversations are the same entity type). Disclosed in the data policy.
- **Working context per turn**: `[system prompt | durable facts | rolling summary | recent window]` — last ~20–30 messages capped at ~3–4k tokens.
- **Rolling summary is live at MVP** (user decision — continuity beyond the window without relying on nano's judgment to persist facts): when messages age out of the window, a nano call folds them into a stored "story so far" summary injected every turn. Known failure mode to watch: summary drift compressing errors.
- **Durable facts are canonical data, not an agent blob**: structured facts go through canonical API ops (nicknames, category rules, budgets); free-text facts land in a small canonical `user_notes` store via `remember`/`recall` canonical operations — third-party agents see the same memory (no split brain). System prompt nudges the model to persist load-bearing facts.
- **No vector store / embeddings at MVP** — notes are injected wholesale.

### 5. Channel adapters: channel-agnostic core, two thin adapters

- **Core `AgentService`**: `handleTurn(userId, inboundMessage) → reply` — owns loop, context assembly, toolkit, summary maintenance. Speaks a *semantic* reply type (text + optional attachments + optional structured choices); knows nothing about WhatsApp or terminals.
- **Adapters normalize in, render out**: inbound events → canonical inbound message (text / Kapso-transcribed voice / image / document); semantic reply → channel rendering (WhatsApp: chunked text, images, buttons/lists; CLI: terminal text).
- **WhatsApp adapter (Kapso)**: HMAC-verified webhooks, **idempotency on message id** (Kapso retries), **per-user serialized queue with ~2–3s debounce** (burst messages become one turn; never two concurrent turns per user), **window awareness as a capability**: exposes `windowOpenUntil` and refuses out-of-window free-form sends by construction — out-of-window policy (templates, nudges) is ticket 014's design space.
- **CLI adapter**: a REPL over the same `AgentService` — the dev/test harness exercising the full agent loop with zero WhatsApp dependency. (Distinct from the user-facing CLI that wraps the canonical API — that standing decision is untouched.)
- **Ruled out at MVP**: a generic channel-plugin abstraction. Two concrete adapters + one core; a third channel earns the generalization when it arrives.
