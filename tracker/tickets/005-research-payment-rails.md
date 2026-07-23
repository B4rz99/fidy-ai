---
id: 005
title: "Research: Colombian payment rails for recurring billing"
label: wayfinder:research
status: closed
assignee: research-subagent (fired at charting, 2026-07-22)
blocked-by: []
resolved: 2026-07-22
---

## Question

Which payment providers can bill Colombian consumers on a recurring/usage basis, and what do they cost?

1. Candidates: Wompi, Mercado Pago, PayU, Bold, ePayco, dLocal, Stripe's actual Colombia status.
2. **Recurring support**: card-on-file subscriptions, PSE limitations for recurring, Nequi/Daviplata options, usage-based (variable-amount) billing support.
3. Fees, payout terms, developer experience (API quality, TypeScript SDKs, webhooks), KYB requirements to onboard as a merchant.
4. A short ranked recommendation for a freemium SaaS charging in COP.

## Resolution (2026-07-22)

Full findings: [research/005-payment-rails.md](../../research/005-payment-rails.md) (merged from branch `research/payment-rails`).

Ranked recommendation (ranking flagged as inference; facts from provider docs):

1. **Wompi (primary)** — only rail with automatic recurring debits across cards + Nequi + Daviplata + Bancolombia button; explicit variable-amount card-on-file for usage-based billing; 2.65% + COP 700 + IVA; next-day payouts; persona-natural self-onboarding. Costs: no official TypeScript SDK; you build retries/dunning yourself; requires a Bancolombia account.
2. **Mercado Pago** — best managed Subscriptions API and the only official TypeScript SDK, but card-centric, pricier (3.29% + COP 800 + IVA), weak on variable amounts.
3. **ePayco** — tokenization + recurrence engine, Node SDK without types, 2.68–3.29%.
4. **dLocal Go** — cheapest headline but SMB-grade, USD fee component, 7-day settlement.
5. **PayU** (recurring discontinued), **Bold** (no recurring API), **Stripe** (unavailable to Colombian merchants).

Structural facts: **PSE cannot do automatic recurring charges**; Bre-B automatic debits emerging in 2026 but too new to build on — keep a `BillingProvider` seam (inference).
