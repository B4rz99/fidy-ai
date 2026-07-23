---
id: 014
title: "Decide: agent proactivity & notification design"
label: wayfinder:grilling
status: open
assignee:
blocked-by: []
---

## Question

Graduated from fog by the WhatsApp research (002). The template rules are now known; decide the proactivity design:

- Which proactive messages exist at MVP (budget threshold alerts? new-recurring-charge detected? weekly summary?) and their frequency — under the constraint that each is a pre-approved **utility template** (~$0.0008/msg) and quality-rating bans are the existential risk (utility-only, low-frequency, per-category opt-in).
- The re-engagement pattern: short utility template → user reply reopens a free 24h window for rich content — where it applies.
- Opt-in capture per message category (interlocks with onboarding/consent, ticket 013).
- How proactivity surfaces on non-WhatsApp channels (MCP/CLI agents pull; does anything push?).

**Constraint from [Decide: ingestion architecture & bank coverage for MVP](006-decide-ingestion-architecture.md) (decision 8):** ingestion needs-review asks (failed parses, ambiguous merges) are batched by default — they ride an already-open 24h session window as one consolidated ask or wait for the user to initiate; no paid template nudges for reconciliation at MVP. Statement-upload ambiguities resolve synchronously in the upload conversation. Proactivity design must not reopen this.
