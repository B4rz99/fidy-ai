---
id: 007
title: "Decide: hosted agent architecture"
label: wayfinder:grilling
status: open
assignee: obarboza
blocked-by: [002]
---

## Question

Design the hosted agent that fronts WhatsApp (and any other channel), as a client of the canonical API:

- LLM provider/model strategy (and cost ceiling per user — feeds pricing).
- Conversation memory model (session vs long-term, what persists).
- Tool set: the agent's tools should map onto the same canonical API operations exposed to third-party agents — confirm or amend.
- Channel-adapter design: WhatsApp adapter shape given the 24h-window/template constraints from 002; how the CLI shares the core.
- Agent runtime approach in TypeScript + Effect-TS (own loop vs SDK).
