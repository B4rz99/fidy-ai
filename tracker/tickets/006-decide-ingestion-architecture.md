---
id: 006
title: "Decide: ingestion architecture & bank coverage for MVP"
label: wayfinder:grilling
status: open
assignee:
blocked-by: [001, 003]
---

## Question

With aggregator research (001) and regulation research (003) in hand, lock the MVP ingestion design:

- Is an aggregator (Belvo et al.) **in or out** of the MVP?
- For notification parsing: which mechanism ships first — email forwarding, granted inbox access, SMS forwarding, or push-notification relay — and which Colombian banks are covered first (Bancolombia, Nequi, Davivienda/Daviplata, BBVA, Banco de Bogotá…)?
- Statement upload: which formats/banks at launch?
- How the three layers reconcile (dedup between a forwarded notification and a later statement line).
