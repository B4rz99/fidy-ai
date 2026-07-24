---
id: 015
title: "Task: Wompi merchant onboarding prerequisites"
label: wayfinder:task
status: open
assignee: obarboza
blocked-by: []
---

## Question

Payments ship in the MVP via Wompi ([pricing decision](010-decide-pricing-and-free-tier.md), decision 5). Wompi onboarding for a persona natural has lead-time-sensitive prerequisites — start them now so billing isn't blocked at implementation time:

1. **Bancolombia account** — payouts land only in a Bancolombia account, and for persona natural it must be **>30 days old** at Wompi signup. Open it immediately if one doesn't exist.
2. **Active RUT** for the persona (or decide persona jurídica instead — Cámara de Comercio then also required).
3. **Create the Wompi account** (Plan Avanzado aggregator, 2.65% + COP 700 + IVA) once 1–2 are in place; self-serve KYB takes 1–3 business days.
4. Note operational facts for the spec: **first payout is held 30 days** after the first transaction, then next-day.

HITL — the human must open the bank account and complete KYB. Resolution records: account status, RUT status, Wompi merchant id location (secrets manager, not the repo), and any surprises in the KYB flow.

## Progress (2026-07-23)

Session with obarboza established:

1. **Persona type decided: persona natural.** Personal Bancolombia account + personal RUT both already exist, making this the zero-lead-time path; migrating the merchant to a SAS later stays open if the product warrants it.
2. **Bancolombia account: ✅ exists, >30 days old** — Wompi's account-age requirement already satisfied.
3. **RUT: ✅ active** with DIAN.
4. **Remaining: Wompi signup + KYB** (checklist handed to obarboza in-session; self-serve, 1–3 business days). Ticket stays open until the merchant account is approved and keys are stored in the secrets manager.
