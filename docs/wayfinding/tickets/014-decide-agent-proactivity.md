---
id: 014
title: "Decide: agent proactivity & notification design"
label: wayfinder:grilling
status: closed
assignee: obarboza
blocked-by: []
resolved: 2026-07-22
---

## Question

Graduated from fog by the WhatsApp research (002). The template rules are now known; decide the proactivity design:

- Which proactive messages exist at MVP (budget threshold alerts? new-recurring-charge detected? weekly summary?) and their frequency — under the constraint that each is a pre-approved **utility template** (~$0.0008/msg) and quality-rating bans are the existential risk (utility-only, low-frequency, per-category opt-in).
- The re-engagement pattern: short utility template → user reply reopens a free 24h window for rich content — where it applies.
- Opt-in capture per message category (interlocks with onboarding/consent, ticket 013).
- How proactivity surfaces on non-WhatsApp channels (MCP/CLI agents pull; does anything push?).

**Constraint from [Decide: ingestion architecture & bank coverage for MVP](006-decide-ingestion-architecture.md) (decision 8):** ingestion needs-review asks (failed parses, ambiguous merges) are batched by default — they ride an already-open 24h session window as one consolidated ask or wait for the user to initiate; no paid template nudges for reconciliation at MVP. Statement-upload ambiguities resolve synchronously in the upload conversation. Proactivity design must not reopen this.

## Resolution (2026-07-22)

Grilled with obarboza; six decisions locked. The 006 constraint is respected: the manual-entry reminder prompts for data never received (cash, unshared push notifications), not reconciliation of data already held.

### 1. Catalog: four proactive categories, nothing more

Budget threshold alerts, new-recurring-charge detected, weekly summary, and **manual-entry reminder** (added during grilling — covers what email ingestion structurally can't: cash and push-only wallets when the user doesn't share the screenshot). Every proactive message is a pre-approved WhatsApp **utility template** (~$0.0008/msg, research 002). Explicitly excluded at MVP: daily digests, "we miss you" re-engagement, anomaly/unusual-spend alerts (false positives burn quality rating), and reconciliation nudges (already banned by 006).

### 2. Per-category trigger rules

- **Budget threshold alerts**: fixed thresholds at **80% and 100%** of each budget's monthly amount (not user-tunable at MVP). Each threshold is a monotonic latch — fires at most once per budget per month, immune to boundary flapping. Overshoot past 100% stays silent; the weekly summary picks up the aftermath.
- **New-recurring-charge alerts**: bound to the event "new recurring series confirmed", agnostic to the detector (detection approach is still fog). **Daily digest rule**: max one template/day listing all series confirmed that day. **Cold-start suppression**: series confirmed from backfill (initial statement uploads / first ~30 days of history-building) never trigger templates — they surface in the conversation already underway or in the first weekly summary.
- **Weekly summary**: teaser template with three variable slots (total spent, delta vs. previous week, top category) ending in an invitation to reply for the full breakdown. Default **Sunday 6pm America/Bogota**, day/time user-adjustable conversationally (per-user schedule, no broadcast hour). Skipped entirely on zero-transaction weeks.
- **Manual-entry reminder**: **user-chosen preset cadence** (daily / weekdays / every 3 days / weekly), chosen at opt-in; phrased as a question. Activity-aware triggering (fire only when the user's logging rhythm breaks) is a documented later refinement, not MVP.

### 3. Universal reply pattern; no nudge state machine

Every template is **self-contained but answerable**: it delivers its full headline (no clickbait) and ends with a natural reply affordance. A reply reopens the free 24h window and the rich follow-up (breakdown, chart image, logging conversation) happens as ordinary conversation — this is where research 002's template-then-window re-engagement pattern applies, uniformly. Architecturally: **proactive sends append to the transcript** like any agent message; a reply is a normal `AgentService.handleTurn` turn (007). The outbound scheduler sits outside the agent loop (nudges are not agent tools, per 007) but writes into the same conversation history.

### 4. Opt-in: contextual capture, per-category ledger records

No onboarding batch of toggles. Each category is offered at its natural moment: budget alerts when the first budget is created; recurring-charge alerts when the first series is confirmed (in-conversation during backfill); weekly summary at end of onboarding once first data landed; manual-entry reminder the first time the user logs something manually (cadence captured in the same exchange). Every opt-in/revocation appends a **per-category consent record to the 013 ledger** (timestamped message pair as proof). **No template is ever sent in a category without its ledger record.** Revocation is conversational and honored immediately; a "no" is never re-asked proactively.

### 5. Global governor (quality rating is the existential risk)

- **Delivery window 9am–7pm America/Bogota**: event-driven alerts arising outside it queue until 9am. User-chosen schedule times are clamped to the window.
- **No global daily cap** — per-category rules (monthly latches, daily digest, chosen cadence, weekly schedule) already bound the realistic worst case (~4/day for a fully opted-in user on an unusual day).
- **Ignore-backoff** on the schedule-driven categories (summary, reminder): after 4 consecutive sends with no reply, the next send appends "¿quieres que te siga enviando esto?"; two more unanswered → **auto-pause the category**, mentioned next time the user initiates. Re-enabling is one message. Event-driven categories are exempt. (Numbers are spec knobs; structure is locked.)
- **Rating kill switch**: monitor WABA quality rating via Kapso/Meta API. **Medium** → auto-pause summary + reminder, keep budget + recurring-charge alerts. **Low** → halt all templates, ops alert. Recovery is manual.

### 6. Channels: proactivity is data first; WhatsApp is the only push at MVP

Every proactive event (threshold crossed, series confirmed, summary generated, reminder due) is a **canonical event/insight record** with lifecycle state (pending / delivered / read / dismissed), created via the canonical API. The WhatsApp scheduler is one _consumer_ of that stream — it applies the opt-in ledger, delivery window, and backoff, sends templates, and updates lifecycle state. **CLI and MCP agents pull the same stream** via a canonical "list pending insights" operation (zero private machinery, 007's parity rule). Nothing else pushes at MVP; third-party webhooks are the shaped-for post-MVP extension.
