---
id: 002
title: "Research: WhatsApp Business API constraints"
label: wayfinder:research
status: open
assignee: research-subagent (fired at charting, 2026-07-22)
blocked-by: []
---

## Question

What are the real constraints of building the primary product interface as a WhatsApp agent?

1. **Official WhatsApp Business Cloud API**: current pricing model (per-message/per-template changes since 2025), the 24-hour customer-service window, template-message approval and categories, and what that implies for agent-initiated messages (nudges, alerts, weekly summaries).
2. **Media & modality support**: receiving voice notes, images (receipt photos), documents (PDF statements); sending charts/images.
3. **Policy**: restrictions on financial-services bots, verification/approval process for a fintech, account-ban risks.
4. **Integration routes**: direct Meta Cloud API vs BSPs (Twilio, 360dialog, Gupshup…) — cost/DX tradeoffs. Note why unofficial APIs (Baileys etc.) are a non-option for a real product.

Findings expected on branch `research/whatsapp-api` as `research/002-whatsapp-business-api.md`.
