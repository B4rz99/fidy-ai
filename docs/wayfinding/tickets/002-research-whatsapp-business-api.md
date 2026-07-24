---
id: 002
title: "Research: WhatsApp Business API constraints"
label: wayfinder:research
status: closed
assignee: research-subagent (re-fired 2026-07-22 with Kapso-first scope; original charting agent stopped before producing findings)
resolved: 2026-07-22
blocked-by: []
---

## Question

What are the real constraints of building the primary product interface as a WhatsApp agent?

1. **Official WhatsApp Business Cloud API**: current pricing model (per-message/per-template changes since 2025), the 24-hour customer-service window, template-message approval and categories, and what that implies for agent-initiated messages (nudges, alerts, weekly summaries).
2. **Media & modality support**: receiving voice notes, images (receipt photos), documents (PDF statements); sending charts/images.
3. **Policy**: restrictions on financial-services bots, verification/approval process for a fintech, account-ban risks.
4. **Integration route — Kapso first**: the user intends to use **Kapso** for everything WhatsApp-related. Evaluate Kapso as the primary candidate: capabilities, pricing, agent-building features, webhook/API/TypeScript DX, how it maps onto Meta's pricing and template rules, and its limits. Compare briefly against direct Meta Cloud API and BSPs (Twilio, 360dialog, Gupshup…) only as fallback context. Note why unofficial APIs (Baileys etc.) are a non-option for a real product.

## Resolution (2026-07-22)

Full findings: [research/002-whatsapp-business-api.md](../../research/002-whatsapp-business-api.md) (merged from branch `research/whatsapp-api`).

- **Kapso fits.** Developer platform on the *official* Meta Cloud API: open-source TypeScript SDK (`@kapso/whatsapp-cloud-api`) mirroring Meta's API surface (code ports to direct-Meta), HMAC-signed webhooks with retries/idempotency, workflows-as-code, built-in **voice-note transcription**. Pro ~$25/mo for 100k messages; Meta fees passed through with no markup.
- **Economics favor this UX in Colombia**: user-initiated conversation + all replies in the 24h window are **free**; agent-initiated nudges must be pre-approved **utility templates** (~$0.0008/msg — Colombia is the cheapest market; exact COP rate card still to verify). Pattern: short utility template → user reply reopens a free 24h window.
- **Media works end-to-end**: voice notes (transcribed), receipt photos, PDF statements in; charts out as rendered images. Buttons/lists/Flows for structured input; no native chart widget.
- **Policy edges**: PFM assistant is not a prohibited vertical, but no promoting loans/P2P lending/crypto; never solicit full card/account/ID numbers in chat; explicit opt-in per message category + human escalation path; Meta business verification of the legal entity. **Quality-rating bans are the existential risk** — keep nudges utility-only, low-frequency.
- **Risks**: Kapso is a ~2-year-old solo-founder company (Chile); lock-in low-to-medium — the WABA lives in your own Meta portfolio, so direct Cloud API or BSPs are escape hatches. Unofficial APIs (Baileys) disqualified.
- **Open items**: exact COP rate card; Colombian local number (BYO-SIM) vs default US number; Kapso ToS on data export.
