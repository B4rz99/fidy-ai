---
id: 008
title: "Decide: third-party agent auth & scoping"
label: wayfinder:grilling
status: closed
assignee: obarboza
blocked-by: [003]
resolved: 2026-07-23
---

## Question

How does a user's _own_ agent (Claude Code, an MCP client, a script) get access to that user's data — and only theirs?

- Token issuance flow (OAuth device flow? CLI login? MCP auth spec as of 2026?).
- Scope model: read vs write vs dashboard-edit; per-agent revocation.
- Rate/abuse controls for programmatic access.
- Any consent/logging obligations surfaced by regulation research (003).

## Resolution (2026-07-23)

Grilled with obarboza; six decisions locked.

### 1. Auth model: per-agent bearer tokens, no OAuth server at MVP

- **PAT-style opaque bearer tokens, one per agent**, minted by the user. Stored **hashed** (never recoverable after the one-time reveal), identifiable `fin_` prefix plus a short token-id for naming in chat and support; `last_used_at` tracked per token.
- **The MCP server ships as a _local stdio_ server** reading the token from config — the MCP spec (2025-06-18 revision) only mandates OAuth 2.1 for _remote_ HTTP servers, so this stays spec-clean.
- **OAuth 2.1 authorization server is deferred** until a hosted/remote MCP server exists.

### 2. Issuance: in-chat only, with a WhatsApp-approved device flow for the CLI

- All issuance roots in the chat channel (phone is identity; no passwords). The user asks the hosted agent for a token; the agent sends the disclosure (recipient, scopes, duration), the user confirms in-chat, and a consent-ledger record is appended (shape fixed in ticket 013).
- **The token is delivered via a one-time magic link** that reveals it once in the browser — never pasted into WhatsApp history.
- **CLI login is device-flow-shaped with WhatsApp as the approval channel**: `login` prints a short code, the user sends it to the agent and confirms, the CLI polls and receives its token. No browser, no OAuth server.
- No dashboard token page at MVP (later convenience only).

### 3. Scopes: three coarse scopes, declared in the operation contract

- **`read`** (all queries), **`write`** (mutations to financial data incl. submit-for-extraction), **`dashboard`** (edit the dashboard document). A token carries any subset.
- **Each canonical operation's Effect Schema contract declares its required scope**; HTTP authz middleware, MCP tool visibility, and CLI commands all derive from it — an agent only sees the tools its token can call, so enforcement cannot drift from the surface.
- The hosted agent's user-scoped token carries all three (parity rule from ticket 007 untouched).
- Ledger `data_categories[]`/`purposes[]` fill from a fixed per-scope mapping (e.g. `read` → all financial data categories, "consulta por agente autorizado").

### 4. Lifetime & revocation: revoke-only plus inactivity expiry

- **No fixed expiry; a token unused for 90 days is auto-revoked** (ledger append recorded as expiry). Consent `duration` reads "hasta revocación o 90 días de inactividad".
- **Revocation is in-chat, mirroring issuance**: the agent lists active tokens by name with last-used timestamps; per-token revoke plus a global "revoca todos". Revocations append to the same ledger (symmetric, per ticket 013).

### 5. Rate & abuse controls: two-class per-user limits

- **All of a user's tokens share one quota** — minting another token is never a quota bypass.
- **Two operation classes declared in the same schema contract as the scope**: cheap (CRUD/queries — generous token bucket, order of 60 req/min with burst) and expensive (LLM-backed extraction, rendering — tight daily caps). Standard `429` + `Retry-After`; small per-user concurrency cap.
- **Exact numbers are config, tuned by the pricing ticket (010)** — free/paid caps on expensive ops are a pricing lever.
- A burst of `401`s from unknown/revoked tokens triggers a temporary IP-level block (tokens are the system's only credential).

### 6. Audit logging: metadata-only per-call log

- Every canonical API call appends **`{timestamp, user, token_id, operation, outcome}` — never request/response bodies** (no shadow copy of financial data).
- The hosted agent authenticates as the user through the same path, so its calls land in the same log — one accountability trail for every actor.
- User-facing: the agent answers "¿qué ha hecho el token de X?" from the log. Regulator-facing: consent ledger + audit log are the Ley 1581 security-program evidence, and the trail matches the Decreto 0368 TRD shape for later.
- Retention ~12 months, set in config alongside the data policy.
