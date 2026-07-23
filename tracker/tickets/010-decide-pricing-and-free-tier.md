---
id: 010
title: "Decide: pricing model & free-tier boundary"
label: wayfinder:grilling
status: closed
assignee: obarboza
blocked-by: [004]
resolved: 2026-07-23
---

## Question

With pricing-model research (004) in hand, lock the freemium design:

- The paid unit: flat tier, usage/agent-call credits, or hybrid.
- The free-tier boundary: what a free user gets (manual tracking? dashboard? limited agent messages?).
- COP price points and how LLM cost per user stays bounded.
- Whether payments ship in the MVP or fast-follow (pulls ticket 005's findings in when relevant).

**Constraint from [Decide: hosted agent architecture](007-decide-hosted-agent-architecture.md) (decision 2):** LLM cost per user is bounded at **US$1.50/paying user/month hard cap (alert at $1.00), free tier ~US$0.10/user/month**, with expected blended reality ~US$0.20 on gpt-5.4-nano-only. Pricing design takes these as given; there is no escalation model tier whose cost needs pricing in.

## Resolution (2026-07-23)

Grilled with obarboza; five decisions locked.

### 1. Paid unit: one flat Pro tier, three billing periods

- **COP 9,900/week, 28,900/month, 289,900/year** — IVA-inclusive consumer prices (Netflix/Spotify convention). Yearly ≈ 24,160/mo (~16% discount).
- Monthly deliberately sits **above the ChatGPT Go anchor (20,900)**, just under Netflix Estándar (29,900): premium positioning, cuts/promos are easy later, raises are brutal. The **weekly plan is the down-market/low-commitment entry** (LatAm-standard pattern); no separate trial.
- Research candidates B (two-tier ladder) and C (credits) **rejected**: 007's nano-only architecture removes the model-quality differentiator a ladder needs, and visible credit meters are a trust killer for a finance product.

### 2. Free-tier boundary: free = you track, paid = it tracks for you

- **Free:** WhatsApp conversational quick-log (nano parse assigns category in the same call + user-editable keyword rules — no dependency on 006's evidence-built regexes, which are paid-pipeline cost optimization); web dashboard, budgets, manual entry; weekly teaser summary (014's hook); **single-fact lookups** ("¿cómo va mi presupuesto?" — one deterministic tool call mirroring the dashboard); **one-time statement backfill at onboarding** (taste-of-magic, one bounded LLM spend); API/MCP/CLI at 100 calls/month.
- **Paid:** automatic email-forwarding ingestion + statement/receipt parsing (006's regex→LLM pipeline); generative analysis conversations; recurring/subscription detection + new-charge digest; budget alerts + reminders (014's other proactive categories); unlimited API.
- **Paywall rule (mechanical):** any agent turn that loads transaction history beyond the single record being captured is paid. Free users asking analysis questions get a friendly redirect to Pro.
- Rationale: every Colombian competitor is manual-entry (001), so free tier = market parity, paid tier = the two things nobody else has (auto-ingestion + reasoning agent) — which are also exactly the two LLM-cost surfaces.

### 3. Third-party agent access (API/MCP/CLI): tastable free, unlimited paid

- **Free: 100 calls/month** (~2–3 real agent sessions at 8–15 tool calls/conversation) — deliberately tight; experimentation, not daily-driving. Monthly reset, no rollover, all endpoints weighted equally.
- **Pro: unlimited quota with ~60 req/min burst throttle** (all plans keep the burst throttle — unlimited quota ≠ unlimited concurrency).
- **Agent-legible limits:** remaining-quota response header + quota endpoint; quota-exceeded returns a structured error with upgrade link, so the user's own agent relays the upsell.
- Token-metering explicitly rejected: third-party agents pay their own LLM bill; the canonical API serves near-zero-marginal-cost CRUD.
- These numbers fill the config slots [ticket 008's resolution](008-decide-third-party-agent-auth.md) (§5) deferred to this ticket. Expensive (LLM-backed) operations draw from the same invisible fair-use budget as hosted-agent messages — one budget concept across all transports.

### 4. Cost bounding

- 007's caps stand: US$1.50 hard/paying user (alert $1.00), ~US$0.10/free user. Pro chat's "unlimited" rides an **invisible rolling-window fair-use cap** (Claude-style "se reinicia en unas horas" — never a monthly lockout, never a visible meter).
- Full unit economics (incl. infra): expected variable COGS ≈ COP 2,650/paying user/mo (~11% of net-of-IVA revenue) — LLM ~840 + Wompi fee ~1,745 + WhatsApp templates ~70; worst case (LLM at hard cap) ~34%. Fixed infra (Kapso ~US$25/mo + hosting) amortizes to pennies past ~100 users. **Watch item: free-user burn ≈ COP 460/user/mo** — 1,000 free users ≈ US$110/mo against zero revenue; fine at fintech-typical ~4% conversion, but it's the number to monitor.

### 5. Payments: in the MVP, via Wompi

- Wompi primary (005's ranking: only rail with recurring debits across cards + Nequi/Daviplata, variable amounts, next-day payout); **Mercado Pago documented fallback**. Subscription engine (scheduling, retries, dunning) built in-house — the weekly plan just shortens the cron.
- Free-only launch rejected: in a zero-fee-conditioned market, giving Pro away temporarily and clawing it back poisons conversion.
- Prerequisite spun out as [Task: Wompi merchant onboarding prerequisites](015-task-wompi-onboarding-prereqs.md) — Bancolombia account + RUT need lead time (account must be >30 days old for persona natural; first payout held 30 days).
