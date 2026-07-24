---
id: 006
title: "Decide: ingestion architecture & bank coverage for MVP"
label: wayfinder:grilling
status: closed
assignee: obarboza
blocked-by: [001, 003]
resolved: 2026-07-22
---

## Question

With aggregator research (001) and regulation research (003) in hand, lock the MVP ingestion design:

- Is an aggregator (Belvo et al.) **in or out** of the MVP?
- For notification parsing: which mechanism ships first — email forwarding, granted inbox access, SMS forwarding, or push-notification relay — and which Colombian banks are covered first (Bancolombia, Nequi, Davivienda/Daviplata, BBVA, Banco de Bogotá…)?
- Statement upload: which formats/banks at launch?
- How the three layers reconcile (dedup between a forwarded notification and a later statement line).

## Resolution (2026-07-22)

1. **Aggregator: out, unconditionally.** No revisit during MVP regardless of vendor announcements. Only future-proofing is structural: an ingestion-source abstraction so 2027+ open-finance APIs slot in beside existing sources.
2. **Notification mechanism: email forwarding only.** Per-user ingest address + user-side auto-forward filter. No SMS forwarding or push relay (both require native apps — out of scope); no granted inbox access (Google restricted-scope/CASA burden, credential-adjacent). Push-only banks (Nequi, Daviplata et al.) are handled by the user sharing the notification text/screenshot into WhatsApp — conversational entry doing double duty.
3. **Parsing: regex fast-path → LLM fallback, evidence-first.** Day one is effectively all-LLM. Regexes are fabricated only from collected real samples, per bank-format, as observed volume justifies. Both paths emit into one strict transaction schema (`amount, currency, merchant, date, account_hint, direction, channel`); a regex hit that fails schema validation falls through to the LLM. Unparseable items land in needs-review, never silently dropped.
4. **Evidence corpus:** raw forwarded emails retained ~90 days (debug window) + an indefinite anonymized structural corpus per bank-format (names stripped, digits/amounts masked) that regexes are built and regression-tested against. Both covered by explicit consent in the data-processing policy (per ticket 003 obligations).
5. **Bank coverage: none declared — support is universal and emergent.** Any bank's forwarded email is accepted from day one; the LLM parses it or it goes to needs-review. Regex investment and per-bank onboarding guides follow observed corpus volume. No regex ≠ no support. Launch messaging promises the mechanism, not named banks.
6. **Statements: PDF, CSV, XLSX at launch**, one extraction pipeline into the same transaction schema. Protected-PDF passwords are requested in-chat, used once, never stored (document password, not a bank credential — credential-free posture holds). Paper-statement photos are best-effort conversational entry, not a guaranteed format.
7. **Reconciliation: attestation model.** One transaction entity, multiple immutable source attestations (notification / statement line / manual entry); a merge is a reversible link, nothing is deleted. Matching ladder: deterministic (exact amount + ~4-day posting window + compatible account hints) → LLM judgment above a confidence bar → ask the user in WhatsApp as tiebreaker of last resort. On merge, the statement is authoritative for settled amount/posting date; user-added context from chat (category, notes) survives.
8. **Needs-review UX: batch by default.** Consolidated asks ride an already-open 24h WhatsApp session window or wait until the user initiates; no paid template nudges for reconciliation at MVP. Exception: statement-upload ambiguities are resolved synchronously in the upload conversation. (Constrains ticket 014's proactivity design.)
