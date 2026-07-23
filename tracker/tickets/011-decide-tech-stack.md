---
id: 011
title: "Decide: tech stack beyond TypeScript + Effect-TS"
label: wayfinder:grilling
status: open
assignee:
blocked-by: [001, 002, 007]
---

## Question

Lock the remaining stack, informed by the SDK landscapes from 001/002 and the agent architecture from 007:

- Web framework for the dashboard app; how the dashboard document renders.
- API framework (Effect platform? tRPC-style? plain HTTP) and how CLI + MCP server wrap it.
- Database and schema approach for transactions/budgets/dashboard documents.
- Hosting/deployment target; WhatsApp webhook ingress.
- Statement/receipt parsing pipeline (LLM-based vs library-assisted).
