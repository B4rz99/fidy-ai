---
id: 013
title: "Decide: onboarding, consent & data-protection posture"
label: wayfinder:grilling
status: closed
assignee: obarboza
blocked-by: []
resolved: 2026-07-22
---

## Question

Graduated from fog by the regulation research (003). The obligations are now known; decide how the MVP meets them:

- Consent capture: how prior-express-informed consent is obtained and _proven_ in a WhatsApp-first onboarding (and for third-party-agent access), designed to the Decreto 0368 double-consent shape so open-finance onboarding later is an extension, not a rework.
- The Ley 1581 artifact set: data-processing policy, privacy notice, security program, claims procedure — what exists at launch and where it lives.
- No-KYC stance: confirm the MVP does no identity verification (it holds no funds) and define what account identity _is_ (phone number? email?).
- The "asesoría" line: what the agent may say about money (descriptive analytics, budget coaching) vs what it must never do (personalized investment recommendations) — as an explicit product rule.

## Resolution (2026-07-22)

Grilled with obarboza; four decisions locked.

### 1. No KYC; phone number is the account

- The MVP performs **no identity verification** — it holds no funds, and no KYC obligation attaches to a read-only PFM (per [research 003](../../research/003-colombian-regulation.md)).
- **Account root identity = the WhatsApp phone number (E.164)**, implicitly verified by the channel. Onboarding happens entirely in WhatsApp; there is no separate sign-up form.
- **Web/dashboard access is bootstrapped from chat**: the agent sends a magic link that logs the browser in. The user may optionally attach an **email as a recovery/login credential**. No passwords at MVP. Lost number + no email = support-mediated recovery.

### 2. Consent: in-chat capture, append-only ledger in the Decreto 0368 shape

- **In-chat consent**: on first contact the agent sends a short plain-Spanish disclosure (who we are, data, purposes, duration, revocation) linking the full policy; the user accepts via WhatsApp interactive button ("Acepto") or typed reply. The stored message pair is the proof — timestamped and tied to a channel-verified phone number.
- **Consent-record entity (append-only ledger)**: `{phone, timestamp, policy_version, disclosure_text_hash, disclosure_msg_id, acceptance_msg_id, purposes[], data_categories[], duration, revocation_method}` — a superset of Ley 1581 consent, matching Decreto 0368 (recipient, data, purpose, duration, revocable) so TRD onboarding later extends the record rather than reworking it.
- **Nothing is processed before acceptance**: no finance answers, no stored transaction data until the record exists.
- **Policy versioning**: material policy changes create a new version and trigger in-chat re-consent.
- **Revocation is symmetric**: revocation events append to the same ledger.
- **Third-party-agent access reuses the ledger**: every API-token grant appends a consent record scoped to that token (recipient = the named agent, data categories, purpose, revocable by killing the token). Auth _mechanism_ stays in ticket 008; the record shape is fixed here. Proactivity opt-ins (ticket 014) can likewise append per-category consent records.

### 3. Ley 1581 artifact set at launch

- **Política de tratamiento de datos**: full Spanish document at a stable public URL (`/privacidad`), source-controlled so `policy_version` in the ledger points at an exact revision. Discloses purposes, categories, retention, US-cloud transfer (SIC adequacy list), titular rights.
- **Aviso de privacidad**: the in-chat disclosure message _is_ the aviso (links the política). One text, captured verbatim in the ledger.
- **Consultas y reclamos**: the WhatsApp agent recognizes data-rights requests and routes them to a tracked queue with statutory deadlines (consultas 10 business days, reclamos 15); fallback email in the policy. No separate portal.
- **Security program**: internal markdown doc proportionate to MVP — access control, encryption in transit/at rest, no bank credentials stored, breach response, consent ledger as accountability evidence.
- **Deferred with tripwire**: RNBD registration (below 100,000 UVT asset threshold; revisit on threshold or if TRD onboarding demands voluntary registration).
- **Lawyer review of política + consent texts is a launch gate, not a design dependency** — draft in-house during build, one-time Colombian lawyer review before public launch.

### 4. The asesoría line: three-tier product rule

- **Always allowed — descriptive & behavioral**: anything computed from the user's own data (spending, trends, categories, subscriptions), budget coaching, saving-behavior nudges.
- **Allowed with framing — generic financial education**: explaining what a CDT/fondo/interest rate is, in general terms, never "you should." Pushed for a personal call, the agent gives a fixed redirect: it does not make investment recommendations; consult a licensed advisor.
- **Never**: personalized investment recommendations (naming products/securities/allocations for _this user_), steering to specific credit products for commission, tax advice.
- **Nudge reading**: behavioral nudges about the user's own spending/saving are fine even when numeric; attaching an investment _product_ is the line (Decreto 661 asesoría risk).
- **Enforcement is a spec artifact**: rule in the agent's system prompt, eval cases for boundary questions ("¿me conviene un CDT?" family), fixed redirect response in the spec — auditable if the SFC asks.
