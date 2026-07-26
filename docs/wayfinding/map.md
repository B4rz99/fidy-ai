---
labels: [wayfinder:map]
created: 2026-07-22
---

# Map: Agent-first personal finance app for Colombia

## Destination

A **buildable MVP spec** for an agent-first personal-finance product for Colombia (Monarch-style, adapted to a pre-open-banking market): product scope, data-ingestion strategy, agent architecture, agent-facing surface, editable-dashboard model, pricing, compliance posture, and tech stack all decided — ready to hand to implementation sessions.

**✅ Destination reached (2026-07-23): the spec is GitHub issue #1** — assembled here as a root `SPEC.md`, retired when the tracker moved to GitHub. The map is complete; implementation sessions start from the spec. Only [Task: Wompi merchant onboarding prerequisites](tickets/015-task-wompi-onboarding-prereqs.md) remains open — a launch-gate errand running in parallel, not a decision on the route.

## Notes

- **Tracker**: GitHub issues now (`docs/agents/issue-tracker.md`); this map ran on local markdown, archived at `docs/wayfinding/tickets/NNN-slug.md` — a ticket's frontmatter `assignee` was the claim, `blocked-by` listed ticket ids, and the frontier was open tickets with neither.
- **Skills to consult**: `/grilling` and `/domain-modeling` for decision tickets, `/prototype` for prototype tickets, `/research` for research tickets.
- **Standing decisions from charting** (2026-07-22):
  - Real **product from day one** — multi-user; regulation and WhatsApp-compliance questions are MVP-blocking, not deferrable.
  - **Layered ingestion baseline** (no open banking until ~2027): bank-notification parsing (SMS/email/push forwarded by user) + conversational entry via the agent (text, voice notes, receipt photos) + statement upload (PDF/CSV). Aggregator sync (Belvo et al.) is pending research, not assumed.
  - **MVP feature scope**: transactions, categorization, budgets, recurring/subscription detection. Nothing else.
  - **Editable web UI = declarative dashboard document**: the dashboard is a blocks/widgets document (JSON/DSL). The user edits it through the UI; the user's agent edits the _same document_ through tool calls. One source of truth.
  - **One agent-facing surface, three transports**: a canonical authenticated API; a thin CLI and an MCP server wrap it; the hosted WhatsApp agent is just another client of the same API. Users' _own_ agents are first-class consumers.
  - **Freemium direction**; concrete pricing model undecided (leaning usage/agent-call based — needs research).
  - **Spanish-only, COP-only**, Colombian category taxonomy (domicilios, Nequi/Daviplata transfers, etc.).
  - **TypeScript + Effect-TS** is fixed; all other stack choices are open.
  - **Kapso** is the intended platform for everything WhatsApp-related (added 2026-07-22, after charting).
  - User's global code principles apply: functional, atomic, type-strict, no silent fallbacks.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

- [Research: competitor & aggregator landscape in Colombia](tickets/001-research-competitors-and-aggregators.md) — no viable aggregator for MVP (Belvo exited Colombia; rivals are validation-only or enterprise-gated); every active Colombian PFM is manual-entry; notification parsing has working precedent (Bankity); open-finance data realistically ~H2 2027+.
- [Research: WhatsApp Business API constraints (Kapso-first)](tickets/002-research-whatsapp-business-api.md) — Kapso fits (official Cloud API, TS SDK, voice transcription, ~$25/mo, low lock-in); replies in the 24h window are free, nudges need utility templates (~$0.0008/msg); never solicit card/account numbers in chat; quality-rating bans are the existential risk.
- [Research: Colombian regulation for a PFM handling financial data](tickets/003-research-colombian-regulation.md) — read-only PFM needs no SFC license; Ley 1581 duties apply from day one (RNBD likely exempt); Decreto 0368/2026 makes open finance mandatory with real APIs ~2027–2028; scraping being regulated out — launch credential-free.
- [Research: pricing models for agent-first consumer products](tickets/004-research-pricing-models.md) — three candidates, strongest: flat ~COP 19,900/mo agent tier (free = deterministic, paid = generative), with cheap-tier and credit-hybrid alternatives documented; decision deferred to the pricing ticket.
- [Research: Colombian payment rails for recurring billing](tickets/005-research-payment-rails.md) — Wompi ranked first (only rail with recurring debits across cards + Nequi/Daviplata, variable-amount billing); Mercado Pago second (best managed subscriptions + only official TS SDK); PSE can't do recurring; Stripe unavailable in Colombia.
- [Decide: onboarding, consent & data-protection posture](tickets/013-decide-onboarding-and-consent.md) — no KYC, WhatsApp phone (E.164) is root identity with optional email recovery; in-chat consent captured in an append-only ledger shaped to Decreto 0368; Ley 1581 artifacts versioned in-repo with the agent as claims channel and lawyer review as a launch gate; three-tier asesoría rule (descriptive always, generic education with redirect, never personalized investment/credit/tax advice).
- [Decide: hosted agent architecture](tickets/007-decide-hosted-agent-architecture.md) — own `@effect/ai` loop (no SDK); OpenAI direct, gpt-5.4-nano only (ceiling US$1.50/user/mo hard, ~$0.20 expected); zero-private-tools parity with the canonical API (schema-derived toolkits, agent-as-user auth); memory = full transcript + rolling summary (live day one) + canonical durable facts, no vector store; channel-agnostic `AgentService` core with Kapso-WhatsApp + CLI-REPL adapters.
- [Decide: ingestion architecture & bank coverage for MVP](tickets/006-decide-ingestion-architecture.md) — aggregator out unconditionally; email forwarding is the sole notification mechanism (push-only banks via WhatsApp share); regex fast-path → LLM fallback with evidence-only regexes into one strict schema; bank coverage universal & emergent, never declared; statements PDF/CSV/XLSX through the same pipeline; reconciliation via immutable attestations with a deterministic → LLM → ask-user ladder; needs-review asks batched into free session windows.
- [Decide: third-party agent auth & scoping](tickets/008-decide-third-party-agent-auth.md) — per-agent hashed bearer tokens (no OAuth server at MVP; MCP is local stdio); in-chat issuance with one-time-link reveal and WhatsApp-approved CLI device flow; three contract-declared scopes (read/write/dashboard) driving tool visibility; 90-day inactivity auto-revoke + in-chat revocation; two-class per-user rate limits with numbers deferred to pricing; metadata-only audit log shared with the hosted agent.
- [Decide: pricing model & free-tier boundary](tickets/010-decide-pricing-and-free-tier.md) — one flat Pro tier at COP 9,900/wk, 28,900/mo, 289,900/yr (IVA-inclusive; weekly = down-market entry); free = you track (quick-log, dashboard, budgets, weekly teaser, one-time statement backfill, 100 API calls/mo), paid = it tracks for you (auto-ingestion, generative analysis, recurring detection, proactive alerts, unlimited API @ 60/min burst); paywall rule = any turn loading history beyond the captured record; payments in MVP via Wompi (Mercado Pago fallback), prereqs spun out to ticket 015.
- [Decide: tech stack beyond TypeScript + Effect-TS](tickets/011-decide-tech-stack.md) — Bun + Effect HttpApi (`effect/unstable/httpapi` at HEAD, not `@effect/platform`; everything derived from Schema contracts); Postgres-only via `@effect/sql-pg` + Effect Migrator (no Redis, no ORM); Vite/React SPA with Tailwind + shadcn/ui, Recharts widgets, TanStack Router/Query; single-process monolith on Railway (Hobby) + Railway Postgres; Resend for inbound ingest + outbound email; parsing = PDFs native to OpenAI, deterministic CSV/XLSX rows, all decoded through the canonical Effect Schema; 007's render-as-PNG endpoint amended out of MVP.
- [Decide: agent-legible response conventions for the canonical API](tickets/016-decide-agent-legible-api-conventions.md) — universal `{ data, next }` envelope via one Schema combinator (top-level `next` only); affordance names are canonical operation ids (identity binding, no rename); three-field affordances (`tool`, typed partial `args`, ≤140-char English `hint`), max 3 per response schema-enforced; handlers propose on state, a contract-derived checkpoint strikes anything the caller's scope/tier can't invoke (the aim — nothing in `next` ever fails — is unbuilt at HEAD: an entry says a call is worth making, not that it will succeed); errors mirror the envelope with a closed code set, paywall errors point at new canonical op `getUpgradeUrl`.
- [Decide: agent proactivity & notification design](tickets/014-decide-agent-proactivity.md) — four utility-template categories only (budget 80%/100% latches, new-recurring-charge daily digest with backfill suppression, weekly teaser summary Sun 6pm, manual-entry reminder on user-chosen cadence); every template self-contained-but-answerable, replies are ordinary agent turns; contextual per-category opt-in appending to the 013 consent ledger; 9am–7pm Bogota delivery window, ignore-backoff auto-pause, quality-rating kill switch; proactive events are canonical records — WhatsApp pushes, CLI/MCP pull, nothing else pushes at MVP.
- [Prototype: dashboard-as-document DSL](tickets/009-prototype-dashboard-dsl.md) — dashboard is a recursive split tree (leaf widgets + weighted `row`/`column` splits; any region splits either axis, "halve a half"), size via integer weights (real resizing, no full/half), positions structural not geometric so the agent edits without collision math and every tree reflows to one deterministic mobile column; four widget types (discriminated union on `type`); adding = pick from a catalog + split a region (no empty canvas); one shared `DashboardEdit` vocabulary both editors emit, all-or-nothing at two decode gates (edit, then document); stored as a never-trusted-raw `jsonb` row, edited only through canonical ops gated by 008's `dashboard` scope. Prototype code since deleted (`2bab4c2b`) — the answer it produced lives in the spec.
- [Task: assemble the MVP spec](tickets/012-assemble-mvp-spec.md) — **`SPEC.md`** assembled at the repo root from all closed decisions and research; remaining fog carried into its §13 "Open items for the build"; resolution closes the map.

## Not yet specified

_Emptied on map completion (2026-07-23): the three remaining patches — Colombian category taxonomy in detail, recurring-detection approach, product naming/brand — were deferred by the resolving tickets as build-time work, and now live in the spec's §13 "Open items for the build"._

## Out of scope

- Post-MVP features: net worth tracking, goals, partner collaboration, full reports suite.
- Open-banking-native integration (Colombia ~2027) — the spec must not foreclose it, but integrating it is a future effort.
- English localization.
- Hosted/remote MCP server and the OAuth 2.1 authorization server it would require — deferred by [Decide: third-party agent auth & scoping](tickets/008-decide-third-party-agent-auth.md); the MVP ships a local stdio MCP server on bearer tokens.
- Native mobile apps (WhatsApp _is_ the mobile channel at MVP).
- Chart images over WhatsApp and the canonical render-widget-as-PNG endpoint — amended out of ticket 007 by [Decide: tech stack beyond TypeScript + Effect-TS](tickets/011-decide-tech-stack.md); the agent answers in text at MVP, revivable as a new canonical endpoint later.
