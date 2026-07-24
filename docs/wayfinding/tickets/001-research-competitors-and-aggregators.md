---
id: 001
title: "Research: competitor & aggregator landscape in Colombia"
label: wayfinder:research
status: closed
assignee: research-subagent (fired at charting, 2026-07-22)
blocked-by: []
resolved: 2026-07-22
---

## Question

Who already plays in this space in Colombia, and can any aggregator deliver bank connectivity today, pre-open-banking?

1. **Direct PFM competitors** serving Colombia (local or LatAm apps doing budgets/transaction tracking — active and notable failures): what they offer, how they ingest data, pricing, traction.
2. **Aggregators / open-finance APIs with Colombian coverage** — Belvo, Prometeo, Finerio Connect, Palenca, Minka, any others: which Colombian banks they cover, connection method (credentials/scraping vs API), reliability reputation, pricing, developer experience, and legal standing pre-regulation.
3. Verdict material: does aggregator-backed sync look viable enough to consider for MVP, or is layered manual/notification ingestion the only realistic baseline?

## Resolution (2026-07-22)

Full findings: [research/001-competitors-and-aggregators.md](../../research/001-competitors-and-aggregators.md) (merged from branch `research/competitors-aggregators`).

**Verdict: aggregator-backed sync is NOT viable for the MVP; layered manual/notification/statement ingestion is the realistic baseline.**

- **Belvo exited Colombia** — as of July 2026 its portal lists only Brazil and Mexico (exit inferred from portal evidence; no public sunset announcement).
- **Prometeo** offers only account _validation_ + B2B payments in Colombia, not consumer transaction history. **Finerio Connect / Syncfy** claim Colombia but are enterprise-sales-to-banks, no public bank list or pricing. **Palenca** is payroll data; **Minka** is payment rails.
- **Regulated open-finance data lands ~H2 2027 at the earliest** (SFC standards due Oct 2026, participant directory Apr 2027, then 12–18-month bank windows).
- **Every active PFM in Colombia is manual/voice-entry** (Bolsillos, Gestiona Plus, MisFinanzasApp…); Bolsillos explicitly waits for open finance. Historical precedent for automatic ingestion: **Bankity (2014) parsed bank alert notifications** — no credentials — across Bancolombia/Davivienda/BBVA. Regional scraping-PFM failures (Fintonic Chile) underline fragility.
- Recommended architecture (inference): an ingestion-source abstraction so 2027+ open-finance APIs slot in beside notification/statement/manual sources. Bre-B (live Oct 2025) standardizes account keys — relevant to future payment features, not MVP ingestion.
