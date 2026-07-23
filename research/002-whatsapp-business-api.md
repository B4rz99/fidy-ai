# Research 002: WhatsApp Business API constraints (Kapso-first)

Ticket: `tracker/tickets/002-research-whatsapp-business-api.md`
Date: 2026-07-22
Method: web research against primary sources (kapso.com, docs.kapso.ai, WhatsApp Business Messaging Policy) plus secondary sources where Meta's developer site was unreachable (blocked by the local network gateway). Claims are tagged **[confirmed]** (read directly from an owning primary source) or **[inference/secondary]** (derived, or sourced from BSP/vendor write-ups of Meta docs).

## Verdict (short)

Kapso fits this product. It is a developer-first layer over the **official Meta WhatsApp Cloud API** (not an unofficial client), with a TypeScript SDK that mirrors Meta's API surface, webhooks with HMAC signatures, serverless functions, and built-in voice-note transcription — everything the agent-first interface needs. Meta's per-message pricing (since July 2025) is unusually favorable in Colombia. The two real risks are (a) Meta-level policy exposure for a finance bot (opt-in discipline, template approval, sensitive-data rules) and (b) vendor risk: Kapso is a young, solo-founder company — mitigated by the fact that the SDK works against Meta directly and the WABA lives in your own Meta Business Portfolio.

---

## 1. Kapso

### What it is

- **[confirmed]** Kapso (kapso.com, docs at docs.kapso.ai, API at api.kapso.ai — the product brands itself "Kapso"; the `kapso.ai` domain hosts its app/docs/API) is a "WhatsApp API for developers": a platform wrapping Meta's official WhatsApp Cloud API with connection management, webhooks, message/media logging, an inbox, visual workflows, AI agents, templates, broadcasts, WhatsApp Flows tooling, serverless functions, a CLI, and an MCP server.
- **[confirmed]** It uses the **official Meta Cloud API** — the TypeScript SDK docs state the SDK "mirrors Meta's official Cloud API surface so anything you build here works against Meta directly," with Kapso as an optional proxy layer adding storage/query extras.
- **[confirmed — press/secondary for company facts]** Founded early 2024 by Andrés Matte (ex-Platanus Ventures GP, Chile), run essentially solo with no employees as of late-2025 press coverage; 10,000+ developers, revenue reportedly growing 30–40% MoM. Not a YC company.

### Pricing (Kapso's own fees)

- **[confirmed, docs pricing FAQ]** Plans: **Free** (2,000 msgs/mo, 1 number + sandbox, 1 GB media), **Pro** (100,000 msgs/mo, 3 numbers, +$10/extra number, 100 GB media), **Platform** (1,000,000 msgs/mo, 50 numbers, +$5/extra, 1 TB) — all plans include unlimited API calls, unlimited AI agents, unlimited workflows, serverless function calls, and a sandbox number. Inbound AND outbound messages count toward the allowance (read receipts excluded).
- **[secondary — search snapshot of kapso.com/pricing]** Pro = **$25/mo** ($0.002 per message over 100k); Platform = **$299/mo**. Free plan includes automatic audio transcription and $2 AI credits; AI usage carries no Kapso markup (payment processing fee 4.4% + $0.30 on top-ups).
- **[confirmed]** **Meta's fees are pass-through with no markup**: either pay Meta directly via your Meta Billing Hub, or pay through Kapso credits where Kapso deducts "Meta's published USD price ... with no added fee." Billing mode applies to the whole WABA. Credits mode requires Kapso-managed Meta credentials and switching later requires support (mild lock-in lever — see risks).

### Agent-building features

- **[confirmed]** **Workflows**: graph of nodes (start, send-text/template/interactive, wait-for-response, set-variable, decide, function, **agent node**, handoff, webhook, emit-event, call-workflow) triggered by e.g. `inbound_message`. Buildable visually or **as code** via `@kapso/workflows` npm package + `@kapso/cli` (`kapso pull` / `kapso build` / `kapso push`).
- **[confirmed]** **Serverless functions**: JavaScript on **Cloudflare Workers** (`handler(request, env)` contract), with `env.KV` (per-project KV store) and `env.DB` (Cloudflare D1 database), encrypted secrets, hosted invoke URLs. Used for webhook processing, workflow function/decide nodes, and **agent tools**. Deployed via dashboard/API (CLI does not manage functions yet).
- **[confirmed]** **AI extras**: automatic transcription of inbound voice notes (`message.kapso.transcript`), WhatsApp Flows agent (generates Meta Flows JSON from natural language), MCP server for live WhatsApp ops, published agent skills (`gokapso/agent-skills` on GitHub).
- **[inference]** For this product, the likely architecture is *not* Kapso's hosted agent nodes but Kapso as transport: inbound webhook → your own agent backend (own LLM calls, own ledger/DB) → outbound sends via SDK. Kapso explicitly supports this ("connect from your own app over APIs and webhooks"); its hosted workflow/agent layer is optional.

### Developer experience (API / webhooks / TypeScript)

- **[confirmed]** **TypeScript SDK**: `@kapso/whatsapp-cloud-api` (open source, github.com/gokapso/whatsapp-cloud-api-js). Two auth modes: direct Meta access token, or Kapso proxy (`baseUrl: https://app.kapso.ai/api/meta/` + Kapso API key). Covers text/media/interactive/template/location messages, reactions, media upload/get/delete, phone-number settings, calling ops; Kapso-only extras: conversation & message-history queries, contacts, call logs, Supabase sync.
- **[confirmed]** **Webhooks**: JSON over HTTPS, must 200 within 10 s; events `whatsapp.message.received/.sent/.delivered/.read/.failed`, conversation lifecycle, workflow handoff/failure. **HMAC-SHA256 signature** header, idempotency keys, retries at 10s/40s/90s, optional batching/buffering with ordering. Alternative mode forwards **raw Meta payloads** unmodified (SDK ships `normalizeWebhook()`), which keeps your handler portable to a direct-Meta setup.
- **[confirmed]** Media in inbound payloads comes both Meta-style (media ID) and with Kapso helpers: hosted `media_url`, `media_data` (url, filename, content_type, byte_size), and `transcript.text` for audio.
- **[confirmed]** OpenAPI specs published for Platform, WhatsApp, and Workflows APIs; CLI + sandbox + ngrok/Cloudflare-tunnel local dev flow documented.

### Hosting model

- **[confirmed]** Kapso is **cloud-hosted SaaS** (no self-host option documented). Your code runs either on their Cloudflare Workers functions or entirely on your own infrastructure consuming webhooks/APIs.
- **[confirmed]** Number connection options: (1) **Instant setup** — pre-verified US digital number, small refundable deposit; (2) **coexistence** — keep using the WhatsApp Business app alongside the API via QR pairing; (3) **bring your own SIM** — number becomes a dedicated Cloud API number (leaves the app). All use Meta's embedded signup against a WABA in **your own Meta Business Portfolio**. Local Colombian number: bring-your-own-SIM or bring-your-own-Twilio.

### Limits and lock-in risks

- **[confirmed]** Plan ceilings: message allowances (counting inbound too — a chatty agent doubles burn), media storage caps, "integration calls" quotas (Pro 1,000/mo), broadcasts capped at 1,000 recipients per draft-add call.
- **[confirmed]** Meta requirements are not bypassed: display-name review, business verification, WABA review, and payment eligibility can still block sending.
- **Lock-in assessment [inference from confirmed facts]:** LOW-to-MEDIUM.
  - Mitigating: WABA sits in your Meta portfolio; SDK mirrors Meta's Cloud API and runs against Meta directly; raw-Meta webhook mode; open-source SDK.
  - Aggravating: Kapso-credits billing uses Kapso-managed Meta credentials (switch "requires support"); instant-setup US numbers are BSP-provided (portability not documented); conversation history/contacts/transcription live in Kapso's storage; workflows/functions are Kapso-proprietary formats.
  - **Vendor continuity risk**: one-person company, ~2 years old. If it disappears, migration path is real (own WABA + Meta-mirroring SDK) but operational (webhooks, storage, transcription) would need rebuilding on a BSP or direct Cloud API.

---

## 2. Meta's underlying constraints (apply through Kapso)

### Pricing model (current)

- **[confirmed via Kapso docs + multiple secondary sources; Meta's own page unreachable from this network]** Since **July 1, 2025**, Meta charges **per delivered template message** (the old per-conversation model is gone). Rates vary by template category and recipient country.
- **[confirmed/secondary]** Free things: all **free-form (non-template) messages inside the 24-hour customer-service window**; **utility templates inside an open window** (since July 2025); user-initiated service conversations (free since Nov 2024, unlimited). Marketing and authentication templates are **always** charged, window open or not. Click-to-WhatsApp ads / Facebook Page CTA open a **72-hour free entry-point window** covering business messages.
- **[secondary — vendor rate-card compilations; verify against Meta's rate card before budgeting]** Colombia is among the cheapest markets globally: roughly **$0.0125 per marketing** message and **$0.0008 per utility/authentication** message (rates were adjusted upward Oct 1, 2025 but remain lowest-tier; Meta now also bills in COP; rate cards are revised quarterly). Volume tiers reduce utility/auth rates at scale.

### The 24-hour window and what it means for this agent

- **[confirmed — WhatsApp Business Messaging Policy]** A 24-hour customer-service window opens/resets each time the user messages the business. Inside it: free-form messages (any content, media, no pre-approval) and automation are allowed — but a **prompt, clear human escalation path is required** (in-chat human handoff, phone, email, etc.). Outside it: **only pre-approved template messages**, which Meta can review, pause, or reject at any time.
- **Implication for agent-initiated messages [inference]:**
  - **User-initiated conversation (the primary UX): free and unrestricted** — the user texts/voice-notes the agent, and everything the agent replies within 24 h costs $0 to Meta.
  - **Nudges / alerts / weekly summaries (agent-initiated): must be templates.** Transactional alerts ("your card was charged X", "budget threshold reached", "weekly summary is ready") fit **utility** category ≈ $0.0008/msg in Colombia — negligible. A good pattern: send a short utility template that invites a reply; the reply opens a fresh 24-h window for the rich free-form summary.
  - Anything promotional is **marketing** category (~$0.0125/msg, always billed, higher rejection/frequency scrutiny). Keep nudge templates strictly non-promotional or they'll be re-categorized/rejected.
- **[confirmed/secondary]** Template approval: templates are submitted per category (marketing / utility / authentication); utility templates must be non-promotional (no upsell/offers/persuasive CTAs) or Meta recategorizes/rejects them. Kapso exposes template creation/lifecycle APIs and docs.

---

## 3. Media & modality support

- **[confirmed — Kapso's mirror of Meta media API]** Cloud API media limits: **images** jpeg/png 5 MB; **audio** aac/mp3/ogg/opus 16 MB (voice notes are ogg/opus); **video** mp4/3gp 16 MB; **documents** pdf/doc(x)/ppt(x)/xls(x) 100 MB; stickers webp. Upload once → media ID → send.
- **Receiving [confirmed]**: Kapso's `whatsapp.message.received` covers `text, image, video, audio, document, location, interactive, reaction, contacts, template`. So: **voice notes ✓ (with automatic transcription built in), receipt photos ✓, PDF statements ✓** — each delivered with a Kapso-hosted media URL + metadata, no separate Meta media-download dance required (though the Meta-style media ID is also present).
- **Sending [confirmed]**: images (charts rendered server-side and uploaded/sent as image, or via public URL through Kapso's platform upload endpoint), documents, audio, interactive buttons/lists, WhatsApp Flows (forms). **[inference]** WhatsApp has no native chart widget — send charts as rendered images; buttons/lists/Flows cover structured input.

---

## 4. Policy: financial services, verification, ban risk

- **[confirmed — WhatsApp Business Messaging Policy]** Prohibited outright (regardless of licenses held): **payday loans, paycheck advances, peer-to-peer lending, debt collection, bail bonds**, and "real, virtual, or fake currency, including ICOs and binary options" (i.e., crypto promotion). **A personal-finance assistant/PFM app is not in a prohibited vertical** — but the product must never drift into brokering loans or crypto.
- **[confirmed]** Sensitive data: must NOT share or solicit **full payment-card numbers, financial account numbers, personal ID numbers** in chat. For a finance agent this is a hard design constraint: reference accounts by alias/last-4, never collect full credentials over WhatsApp.
- **[confirmed]** Opt-in: business-initiated contact requires the user's number AND explicit opt-in per message category; opt-outs must be honored. Automation is fine but human escalation must exist.
- **[confirmed/secondary]** **Business verification** (Meta Business Portfolio, legal docs — for a Colombian entity, e.g. Cámara de Comercio registration) unlocks higher messaging tiers, more numbers, display name; up to ~30 days, max 3 attempts. Some restricted verticals additionally need category approval for promotional messaging; a PFM tool is unlikely to need this but a licensed fintech may face regional financial-services review **[inference]**.
- **[confirmed]** Ban mechanics: user blocks/reports drive a quality rating; low quality → escalating template/messaging restrictions (1–30 days) up to indefinite lock; termination can bar the business "from all future use of WhatsApp products and services", at Meta's sole discretion. Mitigations: strict opt-in, utility-only nudges, low frequency, easy opt-out, human handoff.

---

## 5. Fallbacks (brief)

- **Direct Meta Cloud API**: free platform access (pay only per-message fees); you build webhooks, media handling, template management, retries yourself. Because Kapso's SDK mirrors this API and the WABA is yours, this is the natural escape hatch. **[confirmed structure / inference on effort]**
- **Twilio**: adds ~$0.005 per message on top of Meta fees (Kapso's own comparison: 100k msgs ≈ $500 on Twilio vs $25 Pro plan); strong infra, weak agent tooling. **[secondary]**
- **360dialog**: flat monthly subscription, no per-message markup, API-only BSP — closest "raw pipe" alternative. **[secondary]**
- **Gupshup**: per-message markup, more marketing-suite oriented. **[secondary]**
- **Unofficial APIs (Baileys, whatsapp-web.js): non-option.** They reverse-engineer WhatsApp Web, violate WhatsApp ToS, and numbers get detected and banned — unacceptable for a product whose entire interface is the WhatsApp number, and disqualifying for a fintech that needs verified business identity and template messaging. **[confirmed ToS violation / widely documented ban behavior]**

---

## Open questions

1. Exact current COP-denominated Colombia rate card (Meta revises quarterly; developers.facebook.com was blocked from this network — check from an unblocked network before budgeting).
2. Whether a Colombian local number via bring-your-own-SIM works smoothly with Kapso coexistence mode, and whether instant-setup US numbers hurt trust with Colombian users (product decision).
3. Kapso Terms of Service specifics on data ownership/export of conversation history (docs cover mechanics, not contractual terms).
4. Whether Colombian financial regulation (SFC) imposes chat-retention duties on this product — out of scope here, flagged for a legal ticket.

## Sources

Kapso (primary):
- https://kapso.com/ — product overview
- https://kapso.com/pricing — plans
- https://docs.kapso.ai/docs/introduction — docs index
- https://docs.kapso.ai/llms.txt — full docs map
- https://docs.kapso.ai/docs/whatsapp/pricing-faq — plan limits, Meta billing pass-through
- https://docs.kapso.ai/docs/whatsapp/meta-message-billing — Meta fee payment modes
- https://docs.kapso.ai/docs/whatsapp/typescript-sdk/introduction — SDK, Meta-mirroring
- https://docs.kapso.ai/docs/platform/webhooks/overview — webhooks, security, retries
- https://docs.kapso.ai/docs/platform/webhooks/event-types — inbound types, media payloads, transcripts
- https://docs.kapso.ai/docs/how-to/whatsapp/connect-whatsapp — number connection modes
- https://docs.kapso.ai/docs/workflows/introduction — workflows-as-code
- https://docs.kapso.ai/docs/functions/overview — Cloudflare Workers functions
- https://docs.kapso.ai/api/meta/whatsapp/media/upload-media — media types/limits (mirrors Meta)
- https://github.com/gokapso/whatsapp-cloud-api-js — open-source SDK
- https://github.com/gokapso/agent-skills — agent skills

Meta / WhatsApp (primary where reachable):
- https://whatsappbusiness.com/policy/ — WhatsApp Business Messaging Policy (financial verticals, opt-in, escalation, enforcement)
- https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing — Meta pricing (NOT fetched: blocked by local network gateway; cited as the authority to verify against)

Secondary (used where Meta pages were unreachable; treat numbers as approximate):
- https://clevertap.com/blog/whatsapp-business-pricing-changes-in-july-2025/ — July 2025 per-message model
- https://www.ycloud.com/blog/whatsapp-api-pricing-update — July 2025 changes, free utility in window
- https://blueticks.co/blog/whatsapp-business-pricing-change-2026-per-message — model mechanics, volume tiers
- https://mazkara.studio/en/newsletter/whatsapp-penetration-latin-america-2026/ — LATAM/Colombia rates
- https://formbeep.com/whatsapp-api-pricing/ — country rate compilation, COP billing currency
- https://www.infobip.com/docs/whatsapp/get-started/business-verification — verification process
- https://www.df.cl/df-mas/punto-de-partida/andres-matte-dejo-platanus-ventures-para-emprender-solo-hoy-kapso-tiene — Kapso company background
- https://github.com/Enriquefft/openclaw-kapso-whatsapp — Baileys ban-risk contrast
