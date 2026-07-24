---
id: 003
title: "Research: Colombian regulation for a PFM handling financial data"
label: wayfinder:research
status: closed
assignee: research-subagent (fired at charting, 2026-07-22)
blocked-by: []
resolved: 2026-07-22
---

## Question

What does Colombian law require of a multi-user product that stores users' financial transaction data but holds no funds?

1. **Data protection**: Ley 1581 de 2012 (habeas data), SIC obligations, RNBD registration, consent requirements, data-residency considerations.
2. **Financial licensing**: does a PFM that only _reads_ financial data (no money movement, no custody) need any Superintendencia Financiera license or registration? Where is the line?
3. **Credential handling**: legal exposure of storing/using users' bank credentials (relevant if an aggregator path is chosen).
4. **Open banking timeline**: actual state of Decreto 1297 de 2022 / SFC's open-finance agenda — what's mandatory, when, and what an MVP should anticipate for ~2027.

## Resolution (2026-07-22)

Full findings: [research/003-colombian-regulation.md](../../research/003-colombian-regulation.md) (merged from branch `research/regulation`).

- **Data controller under Ley 1581 de 2012 from day one**: data-processing policy, privacy notice, provable prior-express-informed consent, security program, claims procedure. SIC fines reach 2,000 SMMLV. **RNBD registration likely exempt** at MVP scale (threshold: 100,000 UVT total assets, ~COP 5,237M in 2026).
- **No data-localization rule** — US cloud hosting permitted (US on SIC adequacy list, CE 005 de 2017).
- **A read-only PFM needs no SFC license.** Regulated lines to avoid: captación masiva, payments, custody, insurance, securities advisory. Nearest gray zone: personalized investment recommendations.
- **Decreto 0368 de 2026 (7 Apr) made open finance mandatory**, replacing voluntary Decreto 1297: banks must expose data APIs; fintechs join voluntarily as Terceros Receptores de Datos vetted by banks (ISO 27001, PCI DSS, RNBD, double-consent flow). Realistic API-data availability: **2027–2028**.
- **Screen scraping is being regulated out** (API-only rule, transition to 7 Aug 2026). Storing bank credentials first-party is the largest avoidable risk — if aggregation is needed, use a third-party aggregator and review indemnities.
- **Lawyer flags**: Ley 1273 criminal exposure for consented scraping; whether in-app recommendations constitute regulated asesoría; TRD onboarding for sub-threshold startups; Ley 1266 if data ever shared with lenders.
