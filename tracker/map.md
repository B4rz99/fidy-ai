---
labels: [wayfinder:map]
created: 2026-07-22
---

# Map: Agent-first personal finance app for Colombia

## Destination

A **buildable MVP spec** for an agent-first personal-finance product for Colombia (Monarch-style, adapted to a pre-open-banking market): product scope, data-ingestion strategy, agent architecture, agent-facing surface, editable-dashboard model, pricing, compliance posture, and tech stack all decided — ready to hand to implementation sessions.

## Notes

- **Tracker**: local markdown. Tickets live in `tracker/tickets/NNN-slug.md`; a ticket's frontmatter `assignee` is the claim; `blocked-by` lists ticket ids. The frontier = open tickets with no open blockers and no assignee.
- **Skills to consult**: `/grilling` and `/domain-modeling` for decision tickets, `/prototype` for prototype tickets, `/research` for research tickets.
- **Standing decisions from charting** (2026-07-22):
  - Real **product from day one** — multi-user; regulation and WhatsApp-compliance questions are MVP-blocking, not deferrable.
  - **Layered ingestion baseline** (no open banking until ~2027): bank-notification parsing (SMS/email/push forwarded by user) + conversational entry via the agent (text, voice notes, receipt photos) + statement upload (PDF/CSV). Aggregator sync (Belvo et al.) is pending research, not assumed.
  - **MVP feature scope**: transactions, categorization, budgets, recurring/subscription detection. Nothing else.
  - **Editable web UI = declarative dashboard document**: the dashboard is a blocks/widgets document (JSON/DSL). The user edits it through the UI; the user's agent edits the *same document* through tool calls. One source of truth.
  - **One agent-facing surface, three transports**: a canonical authenticated API; a thin CLI and an MCP server wrap it; the hosted WhatsApp agent is just another client of the same API. Users' *own* agents are first-class consumers.
  - **Freemium direction**; concrete pricing model undecided (leaning usage/agent-call based — needs research).
  - **Spanish-only, COP-only**, Colombian category taxonomy (domicilios, Nequi/Daviplata transfers, etc.).
  - **TypeScript + Effect-TS** is fixed; all other stack choices are open.
  - User's global code principles apply: functional, atomic, type-strict, no silent fallbacks.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

*(none yet)*

## Not yet specified

- Onboarding & KYC flow — depends on what regulation research surfaces.
- Colombian category taxonomy in detail (seed categories, transfer/app-payment semantics).
- Recurring-detection approach (rules vs model vs agent-judged).
- Agent proactivity model — nudges, alerts, weekly summaries over WhatsApp; hangs on template-message rules from WhatsApp research.
- Statement-parsing specifics per bank (formats, layouts, coverage order).
- Web UI framework/rendering specifics beyond the dashboard-document model.
- Product naming and working brand.

## Out of scope

- Post-MVP features: net worth tracking, goals, partner collaboration, full reports suite.
- Open-banking-native integration (Colombia ~2027) — the spec must not foreclose it, but integrating it is a future effort.
- English localization.
- Native mobile apps (WhatsApp *is* the mobile channel at MVP).
