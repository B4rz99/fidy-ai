# Research 005: Colombian payment rails for recurring/usage-based billing

Ticket: `tracker/tickets/005-research-payment-rails.md`
Date: 2026-07-22
Context: freemium, agent-first personal-finance SaaS billing Colombian **consumers** in COP; TypeScript backend. Needs card-on-file subscriptions and ideally usage-based (variable-amount) charges.

All fees below are the publicly listed list-prices as of mid-2026; every provider negotiates by volume. IVA (19%) applies on top of commissions unless noted.

---

## 1. Stripe: not available to Colombian merchants

- Stripe supports merchant accounts in 46 countries; **Colombia is not one of them** and Brazil is the only supported country in South America ([stripe.com/global](https://stripe.com/global)). Status unchanged into 2026.
- Colombian *customers* can pay Stripe merchants; only local *merchant* accounts are unavailable.
- Common workaround: incorporate a US LLC (e.g. via Stripe Atlas) and run Stripe from the US entity. That adds US tax/banking overhead and FX friction for a COP-denominated consumer product — viable only if a US entity is planned anyway.

**Verdict: excluded as a domestic rail.** (Confirmed fact.)

## 2. Structural constraints of the Colombian market

- **PSE** (ACH Colombia's bank-transfer button) is designed around per-transaction authorization in the payer's own bank portal — **it does not support automatic recurring debits** in its standard form. A limited "PSE Avanza" recurrent mode exists only for specifically enabled merchants. PSE is the right rail for one-off top-ups/first payments, not subscriptions.
- **Bre-B** (Banco de la República's instant-payments system, launched 2025) is starting to enable **automatic debits via Bre-B keys** — fintech DRUO shipped the first implementation in 2026, under a March-2026 regulatory update requiring pre-notification and permission management. Promising future rail for card-less subscriptions, but too new to build on today. (Confirmed fact that it exists; inference that it is not yet production-ready for a small SaaS.)
- Card penetration among Colombian consumers is materially lower than wallet penetration (Nequi, Daviplata). A recurring-billing stack that can debit **Nequi/Daviplata**, not just cards, meaningfully widens the addressable base. (Inference from market structure.)

## 3. Provider-by-provider findings

### Wompi (Bancolombia / Grupo Cibest)

- **Recurring**: first-class "payment sources" API. Tokenize once, then charge server-side against `payment_source_id`:
  - **Cards** (`POST /v1/tokens/cards`) — initial 3DS authentication, then Credential-on-File charges. The `recurrent` flag distinguishes fixed-amount periodic charges (`true`) from **variable-amount stored-credential charges (`false`)** — i.e. usage-based billing on cards is explicitly supported (Mastercard/Visa via RBM).
  - **Nequi** — customer approves the "subscription" on their phone once; subsequent debits are automatic.
  - **Daviplata** — OTP enrollment (max 2 sends/2 validations in production, one subscription per account per business); production use requires activation by Wompi's commercial team.
  - **Bancolombia button** (`BANCOLOMBIA_TRANSFER`) — customer authorizes via an `authorization_url`.
  - Mandatory `acceptance_token` + `accept_personal_auth` on sources and transactions (habeas-data compliance).
  - No PSE recurring.
- **Fees (Plan Avanzado, aggregator)**: **2.65% + COP 700 + IVA** per successful transaction, blended across cards/PSE/Nequi/Daviplata/Bancolombia button; international cards at no surcharge. Plan Gateway: 0% Wompi commission, you pay only rates negotiated with Bancolombia (aimed at >2,000 tx/month merchants with their own acquiring).
- **Payouts**: next business day, into a **Bancolombia account only**. Persona natural: first payout is held 30 days after the first transaction, then next-day.
- **KYB**: self-serve; **persona natural** needs cédula + active RUT + a Bancolombia account >30 days old; persona jurídica adds Cámara de Comercio. Approval in 1–3 business days.
- **DevEx**: clean REST API (docs.wompi.co), sandbox, event webhooks with integrity signatures, tokenization widget. **No official Node/TypeScript SDK** — only small community packages; plan to write a thin typed REST client. Subscription lifecycle (scheduling, retries, dunning) is **your job** — Wompi gives you tokens and charges, not a subscription engine.

### Mercado Pago (Colombia)

- **Recurring**: the most complete managed **Subscriptions (Preapproval) API** in the market — plans or plan-less subscriptions, weekly→annual frequencies, free trials, proration, **automatic retries on rejection, automatic card-status updates from the networks**. Docs list cards, account money, PSE and Efecty around subscriptions, but automatic charging is card/account-money-centric; PSE/Efecty fit the "pending payment" (payer-initiated per cycle) variant. **No true usage-based billing** — closest is payer-chosen amounts ("ideal para donaciones") and proration. Variable monthly amounts would require updating the subscription amount via API each cycle or falling back to card tokens + one-off charges. (Last sentence is inference.)
- **Fees (checkout, official CO page)**: **3.29% + COP 800 + IVA** with immediate availability; 2.99% at 7 days; 2.79% at 14 days. Cash (Efecty) ~COP 2,500/tx. 3 free bank withdrawals/month, then COP 6,500 + IVA (third-party source).
- **Payouts**: money lands in the Mercado Pago wallet per the chosen release schedule (0/7/14 days), then withdrawal to a bank account.
- **KYB**: self-serve onboarding for persona natural or jurídica (standard cédula/NIT + RUT flow).
- **DevEx**: strong — official **`mercadopago` Node SDK v2 is written with full TypeScript typings** (github.com/mercadopago/sdk-nodejs), webhooks/IPN, test accounts, an API reference, even an MCP server and CLI.

### ePayco (Davivienda)

- **Recurring**: dedicated Subscriptions product: **tokenization ("a un clic")**, **recurrence** (daily/weekly/monthly/annual automatic charges), and **domiciliación** (bill-based collection). Customers can enroll cards, wallets and bank accounts. Token-based charging via API supports arbitrary amounts per charge (usage-based possible on tokens). 3DS available via API. PCI DSS Level 1.
- **Fees (aggregator)**: **2.68% + COP 900 + IVA** with a Davivienda account; other banks ~**2.99–3.29% + COP 700–900 + IVA**; +0.8% for international cards; PSE under COP 60,000 charges COP 2,000 + IVA; withdrawals COP 6,500 + IVA. Promotional rates require ≥ COP 20M/month volume.
- **KYB**: self-serve aggregator onboarding (persona natural or jurídica); gateway model requires negotiating directly with banks/redes.
- **DevEx**: official **`epayco-sdk-node`** (maintained; JavaScript, no first-party TS types), epayco.js for client-side capture, docs at docs.epayco.com, confirmation webhooks. Docs quality is noticeably rougher than Wompi/Mercado Pago. (Last clause is inference from doc structure.)

### PayU Latam (Colombia)

- **Recurring**: the legacy **Recurring Payments product is discontinued** ("NO será activada nuevamente" — docs kept for grandfathered merchants). The supported path is the **Tokenization API** (store card → charge token, one-click, batch charges via CSV), which does allow variable amounts — but it is **gated behind a custom commercial agreement** (contact sales to enable).
- **Fees**: **3.29% + COP 300 + IVA** standard (minimums: COP 450 for PSE/Nequi/Botón Bancolombia/Bre-B QR; COP 9,900 for referenced cash). Withdrawals: 3 free/month, then COP 6,500 + IVA; national payout takes ~3 business days. **Inactivity fee** COP 127,700 + IVA/month after 8 months without sales (and >12 months tenure).
- **KYB**: local merchants (Colombian persona natural or jurídica); enterprise-leaning sales process for anything beyond vanilla checkout.
- **DevEx**: official SDKs are **Java and PHP only**; Node packages are unofficial and 6–11 years stale. API is an older SOAP-ish JSON-over-POST style (`payments-api/4.0/service.cgi`).

### Bold

- **Recurring**: **no native subscription/recurring API yet.** Bold's own FAQ says merchants wanting recurring must bring their own tokenization/orchestration and call the payments API per charge, and that dedicated recurring/membership APIs are "coming". Online payments API covers cards (with 3DS), PSE, Nequi; webhooks and a developer portal (developers.bold.co) exist.
- **Fees**: from **2.39% + COP 300** (1-business-day settlement) to **2.99% + COP 300** (instant to Bold account) + retenciones; +1% international cards; promo PSE rates around 1.99% + COP 300 have appeared.
- **Verdict**: attractive fees and momentum, but wrong tool for subscription billing today. (Fee figures partly from a Jan-2025 rate sheet mirrored on Scribd — verify with Bold directly.)

### dLocal / dLocal Go

- dLocal proper is an **enterprise, sales-led cross-border processor** (negotiated pricing, typically quoted 3–5% by third parties; no public rate card) aimed mostly at foreign merchants selling *into* LatAm; KYB is a compliance-driven process aligned to SAGRILAFT/PTEE.
- **dLocal Go** (self-serve SMB product) covers Colombian merchants: **1.99% + USD 0.20** per transaction (cards/cash/bank transfer, taxes excluded), no monthly fee; settlement 3 days (transfers/vouchers) or 7 days (cards); has a **subscription tool** (fixed plans, flexible amounts per client, API scheduling).
- **Verdict**: cheapest headline rate, but a thinner product for a COP-native consumer SaaS: card-centric recurring, USD-denominated fee component, 7-day card settlement, and less depth on Nequi/Daviplata recurring. (Inference.)

## 4. Comparison snapshot

| Provider | Card-on-file recurring | Variable amount | Nequi/Daviplata recurring | List fee (cards) | Payout | TS/Node SDK |
|---|---|---|---|---|---|---|
| **Wompi** | Yes (payment sources, 3DS + COF) | **Yes** (`recurrent:false` COF) | **Yes (both)** + Bancolombia button | 2.65% + $700 + IVA | Next business day (Bancolombia acct) | No official; REST + webhooks |
| **Mercado Pago** | Yes (Preapproval, retries, card updater) | Weak (proration / payer-chosen) | No (wallet = MP account money) | 3.29% + $800 + IVA (immediate) | 0/7/14-day release + withdrawal | **Official TS SDK** |
| **ePayco** | Yes (tokenization + recurrence engine) | Yes (token charges) | Partial (wallet enrollment) | 2.68–3.29% + $700–900 + IVA | Wallet + $6,500 withdrawal | Official JS SDK (no TS types) |
| **dLocal Go** | Yes (subscriptions, cards) | Flexible amounts per client | No | 1.99% + USD 0.20 | 3–7 days | API; SMB-grade |
| **PayU** | Tokenization only, sales-gated; recurring product discontinued | Yes (token charges) | No | 3.29% + $300 + IVA | ~3 days, 3 free/month | Java/PHP only |
| **Bold** | **No recurring API yet** | n/a | No | 2.39–2.99% + $300 | 1 day / instant | REST, no recurring |
| **Stripe** | n/a in Colombia | n/a | n/a | n/a | n/a | n/a |

## 5. Ranked recommendation (freemium consumer SaaS, COP)

1. **Wompi — primary rail.** Only provider with automatic recurring debits across **cards + Nequi + Daviplata + Bancolombia button**, which matches how Colombian consumers actually hold money; explicit variable-amount COF supports usage-based billing; lowest aggregator card rate of the full-service options; next-day payouts; persona natural self-onboarding. Costs: you build the subscription engine (scheduling, retries, dunning) and a thin typed API client yourself, and you need a Bancolombia account. (Capabilities/fees: confirmed. "Best fit" ranking: inference.)
2. **Mercado Pago — strongest managed alternative / fast MVP.** Best subscriptions product (retries, network card updater) and the only official TypeScript SDK; choose it if shipping speed beats wallet coverage and usage-based needs. Weaknesses: card-centric recurring, higher fees, awkward variable-amount billing.
3. **ePayco — credible fallback.** Full recurrence + tokenization engine and an official Node SDK; fees comparable to Wompi with a Davivienda account. Rougher developer experience. (Partly inference.)
4. **dLocal Go — niche.** Consider only if the low headline rate dominates; SMB product, USD fee component, slower card settlement.
5. **PayU — avoid for this use case.** Recurring product discontinued; tokenization behind sales agreements; no Node SDK; inactivity fee.
6. **Bold — not yet.** No recurring API; revisit when their announced subscription APIs ship.
7. **Stripe — only via a US entity**, which is out of scope for a COP consumer product unless a US LLC is planned regardless.

**Suggested architecture note (inference):** use Wompi payment sources for recurring (cards/Nequi/Daviplata), offer PSE only for one-off payments (e.g. annual prepay), and keep the token/charge layer behind an internal `BillingProvider` interface so Mercado Pago or Bre-B automatic debits can be added later without touching the subscription engine.

## Sources

- Stripe global availability — https://stripe.com/global
- Stripe country analyses — https://dodopayments.com/blogs/stripe-supported-countries-alternatives ; https://mazinooyolo.com/blog/stripe-account-in-colombia/
- Wompi plans & pricing — https://wompi.com/es/co/planes-tarifas/ ; https://wompi.com/es/co/planes-tarifas/plan-gateway
- Wompi payment sources / recurring docs — https://docs.wompi.co/en/docs/colombia/fuentes-de-pago/
- Wompi recurring explainer — https://soporte.wompi.co/hc/es-419/articles/36481489643411--Qu%C3%A9-es-pago-recurrente
- Wompi onboarding (persona natural, RUT, bank account) — https://wompi.com/es/co/ayuda/como-crear-cuenta ; https://soporte.wompi.co/hc/es-419/articles/360021056453 ; https://soporte.wompi.co/hc/es-419/articles/360056658413
- Wompi merchant regulations V3-2025 — https://wompi.com/assets/downloadble/reglamento-Comercios-Colombia.pdf
- Mercado Pago subscriptions docs (CO) — https://www.mercadopago.com.co/developers/es/docs/subscriptions/overview
- Mercado Pago subscriptions product page — https://www.mercadopago.com.co/herramientas-para-vender/suscripciones
- Mercado Pago CO fees — https://www.mercadopago.com.co/ayuda/costo-recibir-pagos_220 ; https://www.mercadopago.com.co/herramientas-para-vender/check-out
- Mercado Pago Node SDK (TypeScript) — https://github.com/mercadopago/sdk-nodejs
- PayU Latam fees — https://corporate.payu.com/tarifas-de-payu-en-latinoamerica/ ; https://corporate.payu.com/tarifas-administrativas-latam/
- PayU recurring deprecated — https://developers.payulatam.com/latam/es/deprecated/recurring-payments.html
- PayU Tokenization API — https://developers.payulatam.com/latam/es/docs/integrations/api-integration/tokenization-api.html
- PayU SDKs (Java/PHP only) — https://developers.payulatam.com/latam/en/docs/integrations/sdk-integration.html
- Bold fees — https://bold.co/tarifas ; https://datafonos.bold.co/legal/terminos-y-condiciones-promo-tarifa-199-300-para-nuevos-negocios-junio-2024/
- Bold online-payments API docs (incl. no-recurring FAQ) — https://developers.bold.co/pagos-en-linea/api-de-pagos-en-linea ; https://www.developers.bold.co/pagos-en-linea
- dLocal Go pricing — https://www.dlocalgo.com/pricinglist ; https://helpcenter.dlocalgo.com/en/articles/6960181-dlocal-go-fees
- dLocal Go subscriptions — https://dlocalgo.com/en/recurring-payments ; https://helpcenter.dlocalgo.com/en/articles/7925846-knowing-subscriptions
- dLocal onboarding/KYC — https://docs.dlocal.com/docs/onboarding-process-platforms ; https://www.dlocal.com/faqs/faqs-contact-sales/
- ePayco fees — https://epayco.com/tarifas/ ; https://epayco.com/calculadora-comisiones/
- ePayco subscriptions T&C — https://epayco.com/terminos/suscripciones/
- ePayco tokenization docs — https://docs.epayco.com/docs/tokenizacion-de-clientes ; https://docs.epayco.com/docs/cobrar-con-token ; https://docs.epayco.com/docs/apify
- ePayco Node SDK — https://github.com/epayco/epayco-node ; https://www.npmjs.com/package/epayco-sdk-node
- PSE FAQ (ACH Colombia) — https://registro.pse.com.co/PSEUserRegister/FAQ.html
- PSE recurring limitations / market context — https://www.mouvlatam.com/recursos/recaudo-pse-empresas ; https://btodigital.com/pagos-recurrentes/
- Bre-B automatic debits (2026) — https://www.eltiempo.com/economia/finanzas-personales/debitos-automaticos-con-bre-b-asi-funcionaran-los-pagos-recurrentes-sin-tarjetas-en-colombia-3553078 ; https://www.infobae.com/colombia/2026/05/05/bre-b-habilitara-debitos-automaticos-a-traves-de-cuentas-y-billeteras-en-colombia-asi-funcionara/
