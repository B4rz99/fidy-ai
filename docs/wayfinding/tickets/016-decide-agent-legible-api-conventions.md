---
id: 016
title: "Decide: agent-legible response conventions for the canonical API"
label: wayfinder:grilling
status: closed
assignee: obarboza
blocked-by: []
resolved: 2026-07-23
---

## Question

HATEOAS-style suggested operations, revived for agents ([htmx essay](https://htmx.org/essays/hateoas/)): LLM agents are the first API clients that can act on next-action links they weren't programmed for, and third-party agents ([auth & scoping decision](008-decide-third-party-agent-auth.md)) can't be prompt-engineered — the response body is the only channel for guiding them. Decide the canonical API's agent-legible response conventions:

1. **Response shape** — a shared `data` + `next` (suggested operations) response, expressed as an Effect Schema combinator over the [HttpApi operation definitions](011-decide-tech-stack.md). How do suggested operation names bind to tool names so MCP/CLI toolkits and in-response suggested operations stay in sync?
2. **Suggested-operation conditioning** — which suggested operations appear per response, conditioned on resource state, token scope (008: read/write/dashboard), and tier ([free/Pro boundary](010-decide-pricing-and-free-tier.md)). Discipline: few high-value next-actions, not exhaustive menus — every suggested operation is tokens in an agent's context.
3. **Error shape** — `action_required` errors with reason + next steps + hint (vs bare 4xx), including the paywall case: a free-tier agent crossing the history boundary should receive a self-describing upgrade suggested operation, not a bare 402.
4. **Cost guardrail** — conventions must convert the hosted agent's reasoning tokens into reading tokens, protecting the [gpt-5.4-nano ceiling](007-decide-hosted-agent-architecture.md); verify they don't bloat responses enough to cut the other way.

Layer on top of tickets 007/008/010/011 — contradicts none of them; amend those tickets only if a conflict surfaces.

## Resolution (2026-07-23)

Grilled with obarboza; six decisions locked. No conflicts with 007/008/010/011 — layers cleanly on top.

### 1. Universal response shape

- **Every canonical operation's success response is `{ data, next }`**, applied as a single
  Effect Schema combinator at the operation-definition layer (`withSuggestedOperations(DataSchema)`) — no per-operation
  opt-out, so the shape cannot drift across the derived HTTP/MCP/CLI/toolkit surfaces (011's parity
  machinery extends to the response shape).
- **`next` appears only at the top level of a response, never nested per-item** in list responses —
  suggested operations describe the response as a whole (referencing item ids where needed), not each row.
  Empty `next: []` costs ~4 tokens; no conditional response-shape machinery.

### 2. Name binding: the operation id is the name, everywhere

- A suggested operation's `tool` field **is the canonical operation id** (`createBudget`, `listTransactions`).
  The MCP server and `@effect/ai` toolkit generators expose tools under exactly that id — the
  generators offer no rename option, so the binding is identity and nothing can drift.
- The CLI (its own naming grammar) derives command names mechanically from the operation id and
  **echoes the operation id in help/output**, so a CLI-driving agent resolves `createBudget` → command
  deterministically.
- Rejected: a separate semantic suggested operation vocabulary (HATEOAS-style `rel`s mapped onto operations) —
  reintroduces the sync problem and makes agents learn two vocabularies.

### 3. Suggested-operation shape: three fields, English, no `href`

```json
{
  "tool": "createBudget",
  "args": { "category": "domicilios" },
  "hint": "40% of July spending has no budget assigned"
}
```

- **`tool`** — operation id. **`args`** — optional _typed partial_ of the target operation's input
  schema (derived per-operation; invalid args fail server-side at construction and can't ship).
  Pre-filled args are the reasoning→reading conversion: the server already knows the ids/periods.
  **`hint`** — one sentence, ≤140 chars (schema-enforced), stating _why_ this is a good next step.
- **English throughout** — this is an agent-facing interface, not a human one (product Spanish-only
  notwithstanding).
- No `href`/method (the tool name is the address in all three transports; HTTP agents resolve via the
  derived OpenAPI spec), no human-facing label (the web UI doesn't read `next`).

### 4. Conditioning: handlers propose, an operation-derived checkpoint disposes

- **Layer 1 (state)**: each operation handler returns `data` + candidate suggested operations from domain
  logic (e.g. "12 transactions uncategorized → suggest `categorizeTransaction`"). Code, not config.
- **Layer 2 (scope + tier)**: a single shared checkpoint before serialization strikes any candidate
  the _calling token_ couldn't successfully invoke — missing scope (read from 008's per-operation scope
  declarations, the same field authz enforces) or 010's paywall rule for free-tier callers. Handlers
  never think about scopes/tiers; enforcement and advertising read the same metadata and cannot disagree.
- **Invariant (absolute): `next` never advertises a call that would fail.** No paid-feature
  advertising on free-tier success responses — the upsell channel is the paywall _error_ (§5), which
  fires exactly when intent exists. Rejected: `"requires": "pro"`-marked suggested operations (spends tokens on
  every free response, trains agents that suggested operations sometimes fail).

### 5. Errors mirror the success response; the upgrade link is a canonical operation

```json
{
  "error": {
    "code": "paywall_required",
    "message": "This query loads transaction history beyond the single captured record, which is a Pro feature. Ask the user if they want to upgrade, then call getUpgradeUrl."
  },
  "next": [{ "tool": "getUpgradeUrl", "hint": "Returns a checkout URL to send to the user" }]
}
```

- **HTTP status stays semantically correct** (402 paywall, 403 scope, 429 + `Retry-After` per 008,
  400 validation) but the body is always `{ error: { code, message }, next }` — one grammar for
  success and failure.
- **`code` is a closed, schema-defined set** (`paywall_required`, `scope_missing`, `rate_limited`,
  `quota_exhausted`, `validation_failed`, `not_found`, …) for deterministic branching. **`message` is
  written to the agent**: reason + what to do, English, 1–2 sentences; validation errors carry the
  formatted field-level Schema decode failure.
- **`next` reuses the same suggested operation type and callability invariant** — which forces the upsell to
  become **`getUpgradeUrl`, a new free-callable `read`-scoped canonical operation** returning the
  Wompi checkout URL (fulfills 010's "structured error with upgrade link"; the agent calls it and
  relays the URL to its human). Feeds ticket 012: `getUpgradeUrl` joins the canonical operation set.
- `scope_missing` carries **no suggested operation** — minting/broadening a token happens in WhatsApp chat
  (008), so the resolution lives in the message text. Not every error has a callable next step.

### 6. Cost guardrail: schema-enforced cap, arithmetic verification

- **Hard cap of 3 suggested operations per response** in the schema (`maxItems(3)`) — a handler proposing more
  (post-filter) fails loudly, forcing ranking over enumeration. Raising the cap is a visible one-line
  reviewed change; discipline can't erode handler-by-handler.
- Bounded worst case: 3 × ~45 ≈ **~135 input tokens/response**; a 15-tool-call hosted-agent
  conversation carries ≤ ~2k suggested operation tokens ≈ US$0.0004 — three orders of magnitude under 007's
  ceiling, against which each _used_ suggested operation saves a reasoning detour on the expensive output side
  ($1.25/M out vs $0.20/M in).
- **No runtime measurement machinery at MVP** (token-budget middleware, usage telemetry rejected).
  If suggested operation _follow-through_ is ever in doubt, 008's metadata audit log already answers "was the
  suggested operation called next?" retroactively.
