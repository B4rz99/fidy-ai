# MVP Spec — Agent-first personal finance for Colombia

**Status**: buildable. Assembled 2026-07-23 from the wayfinder map ([tracker/map.md](tracker/map.md)); every design decision below links to the ticket that holds its full rationale. This document is the hand-off to implementation sessions.

**One paragraph**: a Monarch-style personal-finance product for Colombia, built agent-first for a pre-open-banking market. WhatsApp is the primary channel (a hosted agent), a web dashboard is the visual surface, and users' *own* agents (CLI, MCP, scripts) are first-class clients of the same canonical API. Spanish-only, COP-only. Free tier = you track; Pro (COP 28,900/mo) = it tracks for you.

---

## 1. Product scope

**In**: transactions, categorization, budgets, recurring/subscription detection. Nothing else.

**Channels**: WhatsApp (hosted agent, via Kapso), web dashboard (SPA), CLI, local MCP server, plain HTTP API. No native mobile apps — WhatsApp *is* the mobile channel.

**Out of scope for this MVP** (do not build; where noted, do not foreclose):

- Net worth tracking, goals, partner collaboration, full reports suite.
- Open-banking-native integration (Colombia ~2027+) — the ingestion-source abstraction (§4) must leave room for it; integrating it is a future effort.
- English localization.
- Hosted/remote MCP server and the OAuth 2.1 authorization server it would require ([auth ticket](tracker/tickets/008-decide-third-party-agent-auth.md)).
- Chart images over WhatsApp / render-widget-as-PNG endpoint ([stack ticket](tracker/tickets/011-decide-tech-stack.md) amendment) — the agent answers in text; revivable later as a new canonical endpoint.

## 2. Identity, onboarding & consent

Source: [Decide: onboarding, consent & data-protection posture](tracker/tickets/013-decide-onboarding-and-consent.md).

- **No KYC.** The product holds no funds; no identity verification.
- **Root identity = the WhatsApp phone number (E.164)**, implicitly verified by the channel. Onboarding happens entirely in WhatsApp; no sign-up form.
- **Web access bootstraps from chat**: the agent sends a magic link that logs the browser in. Optional **email as recovery/login credential**. No passwords. Lost number + no email = support-mediated recovery.
- **Consent before anything**: on first contact the agent sends a short plain-Spanish disclosure (who we are, data, purposes, duration, revocation) linking the full policy; acceptance via interactive button ("Acepto") or typed reply. **Nothing is processed before acceptance** — no finance answers, no stored transactions.
- **Append-only consent ledger**, one record shape for all consent events:
  `{phone, timestamp, policy_version, disclosure_text_hash, disclosure_msg_id, acceptance_msg_id, purposes[], data_categories[], duration, revocation_method}`
  — a superset of Ley 1581 consent matching the Decreto 0368 shape (recipient, data, purpose, duration, revocable), so open-finance onboarding later extends the record rather than reworking it. Reused by: third-party token grants (§6), proactivity opt-ins (§8). Revocations append to the same ledger (symmetric).
- **Policy versioning**: material changes create a new `policy_version` and trigger in-chat re-consent.

## 3. Compliance posture

Sources: [regulation research](research/003-colombian-regulation.md), [consent ticket](tracker/tickets/013-decide-onboarding-and-consent.md).

- **No SFC license needed** (read-only PFM). **Credential-free posture**: never hold bank credentials; never solicit card/account numbers in chat (WhatsApp policy, [WhatsApp research](research/002-whatsapp-business-api.md)).
- **Ley 1581 artifact set at launch**:
  - *Política de tratamiento de datos*: full Spanish document at `/privacidad`, source-controlled so ledger `policy_version` points at an exact revision. Discloses purposes, categories, retention, US-cloud transfer (OpenAI as US processor is covered here), titular rights.
  - *Aviso de privacidad*: the in-chat disclosure message **is** the aviso; captured verbatim in the ledger.
  - *Consultas y reclamos*: the agent recognizes data-rights requests and routes them to a tracked queue with statutory deadlines (consultas 10 business days, reclamos 15); fallback email in the policy.
  - *Security program*: internal markdown doc — access control, encryption in transit/at rest, no bank credentials stored, breach response, consent ledger + audit log as accountability evidence.
  - RNBD registration deferred (below 100,000 UVT threshold); tripwire documented.
- **Launch gate (not a build dependency)**: one-time Colombian lawyer review of the política + consent texts.
- **The asesoría line — three-tier product rule**, enforced as spec artifacts (agent system prompt + eval cases for boundary questions + a fixed redirect response):
  1. *Always*: descriptive/behavioral analysis of the user's own data, budget coaching, saving nudges.
  2. *With framing*: generic financial education (what a CDT is), never "you should"; pushed for a personal call → fixed redirect to a licensed advisor.
  3. *Never*: personalized investment recommendations, steering to specific credit products, tax advice.

## 4. Ingestion

Sources: [ingestion ticket](tracker/tickets/006-decide-ingestion-architecture.md), [stack ticket](tracker/tickets/011-decide-tech-stack.md) §7–8.

- **No aggregator, unconditionally** (Belvo exited Colombia; see [competitor research](research/001-competitors-and-aggregators.md)). Structural future-proofing only: an **ingestion-source abstraction** so 2027+ open-finance APIs slot in beside existing sources.
- **Three layers**:
  1. **Email forwarding** (the only automated notification mechanism): per-user ingest address (Resend inbound), user-side auto-forward filter. Push-only banks (Nequi, Daviplata…) are covered by the user sharing the notification text/screenshot into WhatsApp.
  2. **Conversational entry** via the agent: text, voice notes (Kapso transcribes), receipt photos, screenshots.
  3. **Statement upload**: PDF, CSV, XLSX. Protected-PDF passwords requested in-chat, used once in-memory (`mupdf` WASM), never stored.
- **Parsing: regex fast-path → LLM fallback, evidence-first.** Day one is effectively all-LLM (gpt-5.4-nano). Regexes are fabricated only from collected real samples per bank-format as volume justifies; a regex hit that fails schema validation falls through to the LLM. Both paths emit into **one strict transaction schema**: `amount, currency, merchant, date, account_hint, direction, channel`. Unparseable items land in **needs-review**, never silently dropped.
- **Pipeline details**: PDF statements go to OpenAI natively (Responses API PDF input — layout-aware); CSV/XLSX parse deterministically (Papa Parse / SheetJS) with one nano column-mapping call per bank format, then rows flow mechanically; photos/screenshots go to nano vision. **Every path ends in structured outputs whose JSON Schema is generated (`JSONSchema.make`) from the canonical Effect Schema transaction contract and is decoded back through it** — a malformed extraction cannot enter the system.
- **Evidence corpus**: raw forwarded emails retained ~90 days (debug window) + an indefinite anonymized structural corpus per bank-format (names stripped, digits/amounts masked) for regex building and regression tests. Both covered by explicit consent.
- **Bank coverage: universal and emergent, never declared.** Any bank's email is accepted from day one; regex investment follows observed corpus volume. Launch messaging promises the mechanism, not named banks.
- **Reconciliation: attestation model.** One transaction entity, multiple **immutable source attestations** (notification / statement line / manual entry); a merge is a reversible link, nothing deleted. Matching ladder: deterministic (exact amount + ~4-day posting window + compatible account hints) → LLM judgment above a confidence bar → ask the user in WhatsApp as last resort. On merge, the statement is authoritative for settled amount/posting date; user-added context (category, notes) survives.
- **Needs-review UX: batch by default.** Consolidated asks ride an already-open 24h WhatsApp window or wait for the user to initiate — no paid template nudges for reconciliation. Exception: statement-upload ambiguities resolve synchronously in the upload conversation.

## 5. Canonical API — the single agent-facing surface

Sources: [hosted-agent ticket](tracker/tickets/007-decide-hosted-agent-architecture.md) §3, [stack ticket](tracker/tickets/011-decide-tech-stack.md) §1, [agent-legible conventions ticket](tracker/tickets/016-decide-agent-legible-api-conventions.md).

**The derivation rule (the load-bearing architectural idea)**: each canonical operation is defined **once** as an Effect Schema contract (`@effect/platform` HttpApi). From that single source derive: the HTTP server, the fully-typed client (consumed by the SPA and CLI), the OpenAPI spec, the MCP tool definitions, and the hosted agent's `@effect/ai` toolkit. Parity cannot drift because nothing is hand-written twice. The contract also declares each operation's **required scope** (§6) and **cost class** (§6), so authz, tool visibility, rate limiting, and affordance filtering all read the same metadata.

**Dogfooding rule**: new capabilities enter the canonical API first — the hosted agent gets zero private tools.

**Response conventions** (all transports):

- **Universal success envelope `{ data, next }`** via one Schema combinator (`withAffordances(DataSchema)`); no per-operation opt-out. `next` appears only at the top level — never nested per-item in lists. Empty `next: []` is fine.
- **Affordance = `{ tool, args?, hint }`**: `tool` is the canonical operation id (identity binding — MCP/toolkit generators expose exactly that id, no rename option; the CLI derives command names mechanically and echoes the id in help/output); `args` is a typed partial of the target operation's input schema, server-validated at construction; `hint` is one English sentence, ≤140 chars (schema-enforced), stating why this is a good next step. No `href`, no human label. English throughout (agent-facing).
- **Conditioning — handlers propose, a checkpoint disposes**: handlers return candidate affordances from domain state; one shared contract-derived checkpoint before serialization strikes anything the *calling token* couldn't successfully invoke (missing scope, or the free-tier paywall rule). **Invariant: `next` never advertises a call that would fail.** No paid-feature advertising on free success responses — the upsell channel is the paywall error.
- **Hard cap: 3 affordances per response** (`maxItems(3)` in schema) — a handler proposing more post-filter fails loudly.
- **Errors mirror the envelope**: correct HTTP status (402 paywall, 403 scope, 429 + `Retry-After`, 400 validation) with body `{ error: { code, message }, next }`. `code` is a closed schema-defined set (`paywall_required`, `scope_missing`, `rate_limited`, `quota_exhausted`, `validation_failed`, `not_found`, …). `message` is written to the agent: reason + what to do, English, 1–2 sentences; validation errors carry field-level Schema decode failures (formatted via `ParseResult.ArrayFormatter` → `{ path, message }`, never raw `ParseError` dumps). Paywall errors carry `next: [{ tool: "getUpgradeUrl", … }]`; `scope_missing` carries no affordance (token changes happen in chat).

**Named canonical operations committed to by decisions** (the full set emerges from the domain model, but these are contractual):

- CRUD/queries over transactions, budgets, categories, recurring series; dashboard-document edit ops (§9, `dashboard` scope).
- `submitForExtraction` — media/statement ingestion (receipt photo, screenshot, PDF/CSV/XLSX statement).
- `remember` / `recall` — the agent-memory `user_notes` store (§7).
- `listPendingInsights` (and lifecycle updates) — the proactive-event stream (§8).
- `getUpgradeUrl` — free-callable, `read`-scoped; returns the Wompi checkout URL (the paywall error's affordance target).
- A quota endpoint + remaining-quota response header (§10).

## 6. Third-party agent auth & scoping

Source: [auth ticket](tracker/tickets/008-decide-third-party-agent-auth.md).

- **Per-agent PAT-style opaque bearer tokens**, minted by the user, stored **hashed**; `fin_` prefix + short token-id for naming in chat; `last_used_at` tracked. No OAuth server at MVP; the **MCP server ships as local stdio** reading the token from config (spec-clean under MCP 2025-06-18 — OAuth 2.1 is only mandated for remote HTTP servers).
- **Issuance is in-chat only**: user asks the hosted agent; agent sends the disclosure (recipient, scopes, duration); user confirms; a consent-ledger record is appended. Token delivered via a **one-time magic link** (never pasted into WhatsApp history). **CLI login is device-flow-shaped with WhatsApp as approval channel**: `login` prints a short code, user sends it to the agent and confirms, CLI polls and receives its token.
- **Three scopes, declared per-contract**: `read` (all queries), `write` (financial-data mutations incl. `submitForExtraction`), `dashboard` (edit the dashboard document). HTTP authz, MCP tool visibility, and CLI commands all derive from the declaration — an agent only *sees* the tools its token can call. The hosted agent authenticates **as the user** with all three scopes, through the same path.
- **Lifetime**: no fixed expiry; **90 days unused → auto-revoked** (ledger append). Revocation is in-chat, per-token or "revoca todos".
- **Rate/abuse**: all of a user's tokens share one quota (minting is never a bypass). Two contract-declared cost classes: **cheap** (CRUD/queries — token bucket, ~60 req/min with burst) and **expensive** (LLM-backed ops — tight daily caps, drawing from the same invisible fair-use budget as hosted-agent messages). Standard `429` + `Retry-After`; small per-user concurrency cap; a burst of `401`s from unknown tokens triggers a temporary IP block. Quota numbers per tier: §10.
- **Audit log, metadata-only**: every canonical call appends `{timestamp, user, token_id, operation, outcome}` — never bodies. Hosted-agent calls land in the same log (one accountability trail). The agent answers "¿qué ha hecho el token de X?" from it. Retention ~12 months (config).

## 7. Hosted agent

Source: [hosted-agent ticket](tracker/tickets/007-decide-hosted-agent-architecture.md).

- **Runtime: own agentic loop on `@effect/ai`** (+ `@effect/ai-openai`). No agent SDK/harness. The loop owns its guards explicitly: max-iteration cap, tool-error feedback to the model, context-window truncation.
- **LLM: OpenAI direct, `gpt-5.4-nano` only** ($0.20/M input, $1.25/M output; vision, tool calling, structured outputs, prompt caching, 400K context). No escalation tier — a bigger model later is a config change. Ingestion's LLM fallback rides the same account and model. Audio is not on-model: Kapso transcribes voice notes first. Code stays OpenAI-compatible (gateway = one-line escape hatch). Known risk: nano-class Spanish tone may feel flat — mitigation is bumping the model id.
- **Cost ceilings (drive pricing and alerting)**: **US$1.50/paying user/month hard cap, alert at US$1.00; free tier ~US$0.10/user/month.** Expected blended ~US$0.20.
- **Tools: strict parity, zero private tools** — the toolkit is generated from the canonical contracts; the agent calls the API as the user (§6). Outside the API: only channel mechanics (session state, send/receive, formatting) — adapter code, never LLM tools. Nudges are not tools (§8's scheduler is separate).
- **Memory**:
  - *Transcript*: persisted fully, channel-agnostic (WhatsApp and CLI conversations are the same entity type). Disclosed in the data policy.
  - *Working context per turn*: `[system prompt | durable facts | rolling summary | recent window]` — last ~20–30 messages capped ~3–4k tokens.
  - *Rolling summary live at MVP*: as messages age out of the window, a nano call folds them into a stored "story so far" injected every turn. Watch: summary drift compressing errors.
  - *Durable facts are canonical data, not an agent blob*: structured facts via canonical ops (nicknames, category rules, budgets); free-text via a `user_notes` store with `remember`/`recall` ops — third-party agents see the same memory. System prompt nudges the model to persist load-bearing facts. **No vector store**; notes inject wholesale.
- **Channel adapters: channel-agnostic core, two thin adapters.**
  - Core **`AgentService.handleTurn(userId, inboundMessage) → reply`** owns the loop, context assembly, toolkit, summary maintenance; speaks a semantic reply type (text + optional attachments + optional structured choices).
  - **WhatsApp adapter (Kapso)**: HMAC-verified webhooks; **idempotency on message id** (Kapso retries); **per-user serialized queue with ~2–3s debounce** (burst messages → one turn; never two concurrent turns per user); **window awareness as a capability** — exposes `windowOpenUntil`, refuses out-of-window free-form sends by construction.
  - **CLI-REPL adapter**: the dev/test harness over the same `AgentService`, zero WhatsApp dependency. (Distinct from the user-facing CLI that wraps the canonical API.)
  - No generic channel-plugin abstraction — a third channel earns it.

## 8. Proactivity & notifications

Source: [proactivity ticket](tracker/tickets/014-decide-agent-proactivity.md).

- **Exactly four proactive categories**, each a pre-approved WhatsApp **utility template** (~$0.0008/msg):
  1. **Budget threshold alerts**: fixed 80% and 100% of each budget's monthly amount; each threshold is a monotonic latch (fires at most once per budget per month). Past-100% overshoot stays silent.
  2. **New-recurring-charge**: fires on "new recurring series confirmed" (detector-agnostic); **max one template/day** listing all series confirmed that day; **cold-start suppression** — series confirmed from backfill/first ~30 days never trigger templates.
  3. **Weekly summary**: teaser with three slots (total spent, delta vs previous week, top category) + invitation to reply. Default Sunday 6pm America/Bogota, per-user adjustable conversationally. Skipped on zero-transaction weeks.
  4. **Manual-entry reminder**: user-chosen preset cadence (daily / weekdays / every 3 days / weekly), captured at opt-in; phrased as a question. Covers what email ingestion can't (cash, unshared push wallets).
  - *Explicitly excluded*: daily digests, "we miss you" re-engagement, anomaly alerts, reconciliation nudges (§4's batching rule).
- **Universal reply pattern, no nudge state machine**: every template is self-contained but answerable — full headline, natural reply affordance. A reply reopens the free 24h window; the rich follow-up is ordinary conversation. Proactive sends **append to the transcript**; a reply is a normal `handleTurn` turn. The outbound scheduler sits outside the agent loop but writes into the same conversation history.
- **Opt-in: contextual, per-category, ledger-backed.** No onboarding toggle batch — each category is offered at its natural moment (first budget created; first series confirmed; end of onboarding; first manual log). Every opt-in/revocation appends a per-category consent record (§2). **No template is ever sent in a category without its ledger record.** A "no" is never re-asked proactively.
- **Global governor** (quality rating is the existential risk):
  - Delivery window **9am–7pm America/Bogota**; out-of-window events queue until 9am; user schedules clamp to it.
  - **Ignore-backoff** on schedule-driven categories: 4 consecutive unanswered sends → next send asks "¿quieres que te siga enviando esto?"; two more → auto-pause, mentioned next time the user initiates. Event-driven categories exempt. (Numbers are config knobs.)
  - **Rating kill switch** via Kapso/Meta API: Medium → auto-pause summary + reminder; Low → halt all templates + ops alert. Recovery manual.
- **Proactivity is data first**: every proactive event is a **canonical insight record** with lifecycle state (pending / delivered / read / dismissed), created via the canonical API. The WhatsApp scheduler is one consumer; **CLI/MCP agents pull the same stream** (`listPendingInsights`). Nothing else pushes at MVP; third-party webhooks are the shaped-for post-MVP extension.

## 9. Dashboard document model

Source: [dashboard-DSL prototype](tracker/tickets/009-prototype-dashboard-dsl.md); reference implementation on branch `prototype/dashboard-dsl` (`prototypes/dashboard-dsl/src/document.ts` is the portable core — schema + tree + edit DSL + pure reducer, zero I/O; lift it into the real codebase).

- **Layout is a recursive split tree**: a node is a widget leaf or a split with weighted children; `axis: row` = side-by-side, `column` = stacked; any region splits either axis recursively. Not a flat list, not pixel coordinates.
- **Size = integer `weight`** within a split (`1:1`, `3:1`…). **Positions are structural, never geometric** — edits name a region (widget id) + axis/side, never x/y/w/h; the agent needs no collision math, and no per-breakpoint layouts exist.
- **Mobile**: every tree reflows to one deterministic column via in-order leaf traversal.
- **Widget = discriminated union on `type`**: `spending-chart`, `budget-bar`, `transaction-list`, `custom-metric`; stable `id`, optional `title`, per-type config; periods are a closed enum.
- **Adding = pick from a catalog + split a region** (no empty canvas; the screen is always fully tiled). The catalog is the "+ Add" palette *and* what the agent chooses from: one entry per widget type, a factory producing a valid default-configured widget.
- **One shared `DashboardEdit` vocabulary** both editors emit: `add-widget` (+`Placement = "top" | "bottom" | { besideWidget, axis, side }`), `remove-widget`, `move-widget`, `resize-widget`, `update-widget`, `set-title`. A UI drag and an agent tool call compile to the same op — no privileged path.
- **All-or-nothing at two loud decode gates**: (1) the edit (agent boundary = untrusted LLM JSON); (2) the resulting document (unique ids, every split ≥2 children, positive weights, valid per-type config). Failure → `Left(EditError)`, document untouched. Reducer invariants: single-child splits collapse; the last widget can't be removed.
- **Storage**: one `jsonb` row, **never trusted raw** — decoded on every read/write. Edit ops are canonical API operations gated by the `dashboard` scope.
- **Rendering**: Recharts through shadcn chart wrappers in the SPA (§11).

## 10. Pricing, free tier & billing

Sources: [pricing ticket](tracker/tickets/010-decide-pricing-and-free-tier.md), [payment-rails research](research/005-payment-rails.md), [Wompi prereqs task](tracker/tickets/015-task-wompi-onboarding-prereqs.md).

- **One flat Pro tier, three billing periods**: **COP 9,900/week, 28,900/month, 289,900/year** — IVA-inclusive consumer prices. Weekly is the down-market/low-commitment entry; no separate trial.
- **Free = you track**: WhatsApp quick-log (nano parses + assigns category in the same call; user-editable keyword rules), web dashboard, budgets, manual entry, weekly teaser summary, single-fact lookups ("¿cómo va mi presupuesto?" — one deterministic tool call), **one-time statement backfill at onboarding**, API/MCP/CLI at **100 calls/month** (monthly reset, no rollover, all endpoints weighted equally).
- **Pro = it tracks for you**: automatic email-forwarding ingestion + statement/receipt parsing, generative analysis conversations, recurring detection + new-charge digest, budget alerts + reminders, **unlimited API with ~60 req/min burst throttle**.
- **Paywall rule (mechanical)**: any agent turn that loads transaction history beyond the single record being captured is paid. Free users asking analysis questions get a friendly redirect (the `paywall_required` error + `getUpgradeUrl` affordance, §5).
- **Fair use**: Pro chat's "unlimited" rides an invisible rolling-window cap ("se reinicia en unas horas" — never a monthly lockout, never a visible meter). Expensive API ops draw from the same budget — one concept across all transports.
- **Unit economics** (watch items for ops): expected variable COGS ≈ COP 2,650/paying user/mo (~11% of net-of-IVA revenue); worst case (LLM at hard cap) ~34%. **Free-user burn ≈ COP 460/user/mo** — the number to monitor as free signups grow.
- **Payments ship in the MVP via Wompi** (Plan Avanzado aggregator, 2.65% + COP 700 + IVA; only rail with recurring debits across cards + Nequi/Daviplata, variable amounts, next-day payout). **Mercado Pago is the documented fallback.** The **subscription engine is in-house**: scheduling, retries, dunning; the weekly plan just shortens the cron. Operational facts: first payout held 30 days after first transaction, then next-day. Merchant onboarding is in flight ([task 015](tracker/tickets/015-task-wompi-onboarding-prereqs.md) — persona natural; bank account + RUT done; Wompi KYB pending; keys land in the secrets manager, never the repo).

## 11. Tech stack & deployment

Source: [stack ticket](tracker/tickets/011-decide-tech-stack.md).

| Layer | Choice |
|---|---|
| Language/runtime | TypeScript + Effect-TS on **Bun** (`@effect/platform-bun`; Node is a one-import escape hatch) |
| API | **`@effect/platform` HttpApi** — contracts once, everything derived (§5) |
| Database | **PostgreSQL only** via `@effect/sql-pg` (pure-JS `postgres` driver) + Effect Migrator; hand-written SQL, every row decoded through Effect Schema. No Redis, no ORM |
| Data shapes | Relational core (transactions, budgets, attestations); `jsonb` for dashboard documents & raw payloads (Schema-validated at the boundary); **insert-only tables** for the append-only ledgers (consent, audit, proactive events); **Postgres-backed job queues** (per-user serialization, ingest processing, corpus expiry) |
| Web app | **Vite + React SPA** (no meta-framework); Tailwind + shadcn/ui (vendored Radix); Recharts via shadcn chart wrappers (dark mode via CSS variables); TanStack Router + TanStack Query over the derived Effect client; served as static files from the API container |
| Hosting | **Single-process modular monolith on Railway** (Hobby, ~US$8–15/mo real) + Railway Postgres + cron. One long-running Bun process, one Effect runtime: HTTP API, webhooks (Kapso, Wompi, Resend), agent loop, queue workers, static files. Serverless ruled out (per-user debounce/serialization needs a persistent process). Escape hatch: it's a Dockerfile + `pg_dump` |
| Email | **Resend** inbound (per-user ingest addresses, MX → parsed JSON webhooks) + outbound (magic links, recovery). Fallback documented: Cloudflare Email Routing + relay Worker |
| WhatsApp | **Kapso** (official Cloud API, TS SDK, voice transcription, ~US$25/mo) |
| LLM | OpenAI direct, `gpt-5.4-nano` for everything (§7) |
| Parsing assists | `mupdf` WASM solely for in-memory PDF decryption; Papa Parse / SheetJS for CSV/XLSX rows. No OCR stack, no table-extraction libraries |

Constraints carried from the user's code principles (apply to all implementation sessions): functional, atomic operations (all-or-nothing, no partial state), pure core with I/O at the edges, type-strict end-to-end (no casts/ignores), behavior-first tests, **no silent fallbacks** — required-but-missing values fail loudly.

## 12. Core domain entities

Consolidated from §§2–10 (names indicative; implementation sessions own the final schema):

- **User** (phone E.164 root identity, optional recovery email, tier, fair-use state)
- **ConsentRecord** (append-only ledger, §2 shape — onboarding, token grants, proactivity opt-ins, revocations)
- **Transaction** + **SourceAttestation** (immutable; notification / statement line / manual entry; reversible merge links)
- **Budget** (with per-threshold monthly alert latches), **Category** + user keyword rules, **RecurringSeries**
- **DashboardDocument** (`jsonb` split tree, §9)
- **InsightEvent** (proactive stream with lifecycle state, §8)
- **AgentToken** (hashed, scopes, `last_used_at`), **AuditLogEntry** (metadata-only, §6)
- **Conversation/Transcript** (channel-agnostic messages) + **RollingSummary**, **UserNote** (`remember`/`recall`)
- **NeedsReviewItem** (failed parses, ambiguous merges), **IngestSample** (evidence corpus, expiring raw + anonymized structural)
- **Subscription/BillingState** (Wompi payment source, period, retries/dunning state)

## 13. Open items for the build (deliberately deferred, not blocking)

1. **Colombian category taxonomy in detail** — seed categories, transfer/app-payment semantics (Nequi/Daviplata transfers, domicilios…). Binds the branded `CategoryId` (§9 deferred item). A product-content decision for an early build session.
2. **Recurring-detection approach** — rules vs model vs agent-judged. §8's trigger contract is detector-agnostic by design; pick during the build.
3. **Product name & brand** — gates domain registration and DNS wiring (Resend MX, Railway custom domain, Kapso webhook URL). Needed before any external-facing deploy.
4. **Dashboard DSL production hardening** (from the [prototype ticket](tracker/tickets/009-prototype-dashboard-dsl.md)): compact agent-facing decode errors (`ArrayFormatter`), brand `CategoryId`/`WidgetId`, canonical-form question (flatten same-axis nesting on write), minimum region size / max split depth, cross-checking widget-referenced entities on the API, catalog presets beyond the four base types.
5. **Config knobs with locked structure**: rate-limit numbers (§6/§10), ignore-backoff counts and delivery window (§8), audit retention (~12 mo), corpus expiry (~90 days), LLM cost alert thresholds (§7).
6. **Asesoría eval cases** — the boundary-question suite ("¿me conviene un CDT?" family) + fixed redirect text (§3).
7. **Launch gates (not build blockers)**: lawyer review of política + consent texts (§3); Wompi KYB completion ([task 015](tracker/tickets/015-task-wompi-onboarding-prereqs.md), in progress — first payout held 30 days).
