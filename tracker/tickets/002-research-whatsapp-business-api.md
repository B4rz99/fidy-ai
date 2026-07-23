---
id: 002
title: "Research: WhatsApp Business API constraints"
label: wayfinder:research
status: open
assignee: research-subagent (re-fired 2026-07-22 with Kapso-first scope; original charting agent stopped before producing findings)
blocked-by: []
---

## Question

What are the real constraints of building the primary product interface as a WhatsApp agent?

1. **Official WhatsApp Business Cloud API**: current pricing model (per-message/per-template changes since 2025), the 24-hour customer-service window, template-message approval and categories, and what that implies for agent-initiated messages (nudges, alerts, weekly summaries).
2. **Media & modality support**: receiving voice notes, images (receipt photos), documents (PDF statements); sending charts/images.
3. **Policy**: restrictions on financial-services bots, verification/approval process for a fintech, account-ban risks.
4. **Integration route — Kapso first**: the user intends to use **Kapso** for everything WhatsApp-related. Evaluate Kapso as the primary candidate: capabilities, pricing, agent-building features, webhook/API/TypeScript DX, how it maps onto Meta's pricing and template rules, and its limits. Compare briefly against direct Meta Cloud API and BSPs (Twilio, 360dialog, Gupshup…) only as fallback context. Note why unofficial APIs (Baileys etc.) are a non-option for a real product.

Findings expected on branch `research/whatsapp-api` as `research/002-whatsapp-business-api.md`.
