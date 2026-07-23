# Research 003: Colombian regulation for a PFM handling financial data

- **Ticket**: tracker/tickets/003-research-colombian-regulation.md
- **Date**: 2026-07-22
- **Scope**: multi-user personal-finance app for Colombia that stores users' financial transaction data; no custody, no payments, no money movement.
- **Method**: web research against SIC, SFC, URF, SUIN-Juriscol/Función Pública decree texts, and Colombian law-firm analyses (Holland & Knight, Pérez-Llorca, Dentons, Deloitte), preferring 2025–2026 material. Confirmed facts are labeled; interpretation is labeled as inference.

## Executive summary

1. The app is a **Responsable del Tratamiento** under **Ley 1581 de 2012** and owes the full habeas-data compliance stack (policy, privacy notice, prior express informed consent, security measures, SIC claim procedures) regardless of size. **RNBD registration** only kicks in above ~COP 5,237 million in total assets (100,000 UVT, 2026), so an MVP is likely exempt from registration but not from anything else.
2. A **read-only PFM needs no SFC license**. The regulated line is crossed by: taking money from the public (captación masiva), lending as a supervised activity, payment initiation/processing, insurance, or securities-market advisory. Storing and displaying a user's own transaction data crosses none of these.
3. **Screen scraping / storing bank credentials is legal today but is being regulated out**: SFC rules make APIs the only authorized data-exchange mechanism inside the open-finance scheme, with the transition window (extended twice) currently ending **7 August 2026**. Holding credentials concentrates security liability under Ley 1581 and probable contract/fraud-liability problems with banks.
4. **Open finance became mandatory in April 2026** (Decreto 0368 de 2026, replacing the voluntary Decreto 1297 de 2022). Supervised entities must expose client data via standardized APIs on a phased schedule (~2027–2028 in practice). Non-supervised fintechs participate **voluntarily** as *terceros receptores de datos* (TRD), vetted by the data-providing banks (ISO 27001, PCI DSS, RNBD, double consent). An MVP built now should be architected to become a TRD.

---

## 1. Data protection: Ley 1581 de 2012 (habeas data)

### Confirmed

- Ley 1581 de 2012 is the general personal-data regime; the **SIC (Superintendencia de Industria y Comercio)** is the data-protection authority and administers the RNBD. It applies to any natural or legal person processing personal data in databases in Colombia.
- The app decides purposes and means of processing, so it is the **Responsable del Tratamiento** (controller). Obligations that apply to every controller, whether or not RNBD-registered:
  - A **política de tratamiento de datos** (data-processing policy) and **aviso de privacidad** (privacy notice).
  - **Prior, express, informed authorization** from the data subject (titular), identifying purposes; the controller must be able to prove the authorization was obtained (Decreto 1377 de 2013, compiled into Decreto 1074 de 2015).
  - A documented **procedure for consultas y reclamos** (data-subject queries and complaints).
  - **Security measures** to prevent unauthorized access, loss, or adulteration (deber de seguridad, art. 17).
  - **Accountability** ("responsabilidad demostrada"): an internal comprehensive data-management program appropriate to the company's size.
- **RNBD registration threshold** (Decreto 090 de 2018, amending Decreto 1074 de 2015): only companies and non-profits with **total assets > 100,000 UVT** and public entities must register their databases. 100,000 UVT ≈ **COP 4,979.9M in 2025** and ≈ **COP 5,237.4M in 2026** (~USD 1.2M). Registered entities must update annually (window Feb 2 – Mar 31) and file semiannual claim reports (mid-Feb and mid-Aug, filed with zero if no claims).
  - Entities below the threshold do **not** register but must still comply with all other Ley 1581 duties.
- **Sanctions**: SIC fines up to **2,000 SMMLV** (monthly minimum wages), which can be successive, plus orders to suspend processing (art. 23–24).
- **International transfers (data residency)**: art. 26 of Ley 1581 prohibits transferring personal data to countries without an "adequate level of protection," per standards set by the SIC in **Circular Externa 005 de 2017** (Título V of the Circular Única, later amendments). The adequacy list includes the **United States**, Mexico, Peru, South Korea, Japan (CE 008/2017), Australia (CE 002/2018), the EU/EEA states, and any country declared adequate by the European Commission. Transfers to listed countries are allowed; the controller must still demonstrate appropriate safeguards (accountability principle). Non-listed countries require an art. 26 exception (notably the titular's express and unequivocal authorization) or an SIC declaración de conformidad.
  - Practical consequence: **hosting on US-based cloud regions (AWS/GCP/Azure US) is permitted**; there is no general data-localization mandate in Colombia today.
- Financial/transaction data is **not "sensitive data"** under art. 5 of Ley 1581 (sensitive = health, biometrics, political/religious views, sexual life, etc.). It is private/semi-private data, still fully protected.

### Inference

- An MVP-stage company will almost certainly be **below** the RNBD asset threshold, so the concrete launch checklist is: data-processing policy + privacy notice + consent capture with proof + security program + claims procedure. Budget for RNBD registration once assets pass 100,000 UVT.
- **Ley 1266 de 2008** (habeas data financiero) governs credit-standing data circulated to third parties for risk assessment (credit bureaus and their sources/users). A PFM that shows users their *own* data and does not furnish it to lenders for credit decisions should fall under Ley 1581 only. If the product ever sells scores/insights to lenders, Ley 1266 duties (operador/fuente regime) would attach — different, heavier regime.

---

## 2. Financial licensing: does a read-only PFM need the SFC?

### Confirmed

- Colombia has **no general fintech license**. SFC authorization is required only for activities reserved by the Estatuto Orgánico del Sistema Financiero and related rules. The classic bright lines:
  - **Captación masiva y habitual** (Decreto 2920 de 1982 / Decreto 1981 de 1988): receiving money from **20+ persons or 50+ obligations** repayable without goods/services in return. Doing this without authorization is a crime (2–6 years' prison, art. 316 Código Penal). A PFM that holds no funds cannot trigger this.
  - Payment processing / e-money → SEDPE or payment-system regimes; deposit-taking → credit-institution license; insurance; securities intermediation and **investment advisory** (asesoría, Decreto 661 de 2018) → securities-market rules.
- The SFC's own fintech guidance and legal analyses (LatamFintech/Pomelo, SFC publications) confirm the licensing question is driven by the business model; **pure data aggregation/read-only display is not a reserved activity** and involves no SFC license or registration.
- **Sandbox (Decreto 1234 de 2020, SFC "laArenera", CE 006 de 2025)**: a *certificado de operación temporal* (max 2 years) exists for testing innovations that require performing **activities reserved to supervised entities** or a regulatory dispensation. It is not needed for non-reserved activities.
- Under the open-finance framework (see §4), a non-supervised fintech consuming bank data acts as a **Tercero Receptor de Datos (TRD)** — this is **not an SFC license**; eligibility is verified by the data-providing supervised entities themselves against SFC-set requirements (ISO 27001 certification, PCI DSS, RNBD registration, risk policy, consent handling — per CE 004 de 2024 and SFC concept 2024108013-005).

### Inference — where exactly the line is

- **Safe (no license)**: storing/categorizing/visualizing the user's own transactions, budgets, alerts, manual or file-based import, aggregated anonymous analytics.
- **Gray (get advice before doing)**: personalized *investment* recommendations (may constitute regulated "asesoría" in the securities market); routing users to credit products for commission (marketing generally fine, but structure matters); charging to share user data with lenders (Ley 1266 territory).
- **Regulated (license or partner)**: initiating payments/transfers, holding balances or wallets, lending at scale with certain funding structures, FX.
- Note: RNBD registration appears among TRD requirements even though small companies are otherwise exempt from RNBD; how banks apply this to sub-threshold fintechs is an open practical question (lawyer flag).

---

## 3. Credential handling (screen scraping / aggregators)

### Confirmed

- There is **no express statutory prohibition** on screen scraping in Colombia today.
- However, **SFC Circular Externa 004 de 2024** established that inside the open-finance scheme the **only authorized data-exchange mechanism is standardized APIs** (REST/OpenAPI, OAuth 2.0, JSON), and gave supervised entities that had non-conforming models (i.e., scraping-based flows involving vigiladas) a transition period to migrate — originally 18 months, extended by CE 009 de 2025 (+6 months) and **CE 001 de 2026 (3 Feb 2026)** to a total of **30 months, i.e. until 7 August 2026**, with possible further alignment once the mandatory-regime standards issue.
- Storing credentials makes the PFM's credential store part of its Ley 1581 **security duty**; a breach involving bank credentials would expose the company to SIC sanctions (up to 2,000 SMMLV) plus civil liability.

### Inference

- The realistic exposure stack for a scraping path is:
  1. **Contract**: bank terms of service universally prohibit credential sharing; banks can block aggregator IPs and users can lose fraud-protection coverage.
  2. **Criminal-law shadow (Ley 1273 de 2009)**: automated access with the *user's* consent is generally argued to be authorized access, but the question of whether user consent defeats an "acceso abusivo a sistema informático" (art. 269A) claim by a bank has no clean Colombian precedent we could find — genuine lawyer question.
  3. **Regulatory direction**: the API-only rule plus the mandatory open-finance decree mean scraping against supervised entities is a dead-end architecture on a ~1–2 year horizon.
- **Recommendation**: do not store bank credentials first-party. Either (a) launch credential-free (manual/CSV/email-parse import), or (b) use a third-party aggregator that carries the credential risk contractually and is migrating to TRD/API access — and even then, review indemnities.

---

## 4. Open-banking timeline: Decreto 1297 de 2022 → Decreto 0368 de 2026

### Confirmed

- **Decreto 1297 de 2022** (25 Jul 2022, amending Decreto 2555 de 2010) created Colombia's first open-finance framework — **voluntary** for supervised entities, allowing them to share/commercialize consumer data with consent.
- **SFC Circular Externa 004 de 2024** (7 Feb 2024): technical/security standards (APIs, OAuth 2.0, JSON), obligations for data treatment, and rules for vigiladas commercializing tech to third parties; defined the TRD vinculación requirements (ISO 27001, PCI DSS, RNBD, risk policy), with verification by the data-providing entities, not an SFC approval.
- **CE 009 de 2025** and **CE 001 de 2026**: extended the standards-transition period to 30 months (to 7 Aug 2026).
- **Decreto 0368 de 2026** (7 Apr 2026, in force on issuance): **replaces the 1297 voluntary scheme with a mandatory open-finance system**, implementing art. 89 of Ley 2294 de 2023 (National Development Plan). Key points:
  - **Obligatory for essentially all SFC-supervised entities** (banks, financing companies, financial cooperatives, SEDPEs, fiduciarias, broker-dealers, pension-fund managers, crowdfunding entities, insurers) as **data providers**.
  - **Non-supervised third parties (fintechs/PFMs) join voluntarily** as data recipients; the final decree dropped the draft's "terceros de confianza" gatekeeper — **data providers verify recipient eligibility** and must do so under equality/non-discrimination principles.
  - **Double consent**: the recipient obtains prior, express, informed authorization identifying recipient, data, purpose, and duration; the provider must confirm with the titular that the authorization exists before data flows.
  - **Data categories**: products/services held by the client, onboarding (vinculación) data, and general product characteristics.
  - **Costs**: providers may charge recipients only cost-recovery fees for infrastructure (volume-based, non-discriminatory).
  - **Timeline**: SFC has **6 months (to ~7 Oct 2026)** to publish the schedule for issuing technical standards per data category; supervised entities then have **12 months from each standard** (extendable +6 months) to enable access; SFC has **12 months** to stand up the **participant directory**.

### Inference — what an MVP built now should anticipate

- Working API access to real bank data for a voluntary TRD is realistically a **2027–2028** event for the first data categories (standards late 2026/2027 + 12–18-month bank implementation windows). Do not build the MVP assuming API data on day one.
- Sensible MVP sequencing: launch with manual/file import → integrate a Colombian aggregator (e.g., existing scraping-to-API vendors already migrating) as an optional path → prepare TRD eligibility (ISO 27001 program, PCI DSS if card data is touched, consent UX matching the double-consent flow, RNBD) so the app can plug into the mandatory scheme early.
- Build the **consent model now** to the Decreto 0368 shape (recipient identity, data scope, purpose, duration, revocability) — it is a superset of Ley 1581 consent and avoids a migration later.

---

## Items that genuinely require a Colombian lawyer

1. Whether user-consented screen scraping can still expose the company under Ley 1273 (acceso abusivo) or bank ToS claims, and how to allocate that risk contractually with an aggregator.
2. Whether personalized nudges/recommendations in the app could constitute regulated **asesoría** under Decreto 661 de 2018 once investment products are mentioned.
3. TRD onboarding in practice: how banks apply ISO 27001 / PCI DSS / RNBD requirements to a sub-threshold startup, and whether voluntary RNBD registration is possible/needed for TRD status.
4. Ley 1266 exposure if the roadmap ever includes sharing user financial data with lenders or producing credit-relevant scores.
5. Drafting the data-processing policy, consent texts, and cross-border-transfer clauses (US cloud hosting) to SIC standards.
6. Monitoring: the SFC standards calendar due by ~Oct 2026 under Decreto 0368, and any reform bills to Ley 1581 in Congress.

## Sources

Primary / official:
- Ley 1581 de 2012 (texto): https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=49981
- SIC — RNBD page: https://www.sic.gov.co/registro-nacional-de-bases-de-datos
- SIC — RNBD FAQ: https://sic.gov.co/preguntas-frecuentes-rnbd
- SIC — international data transfers (CE 005/2017): https://www.sic.gov.co/boletin-juridico-octubre-2017/transferencia-Internacional-de-datos-personales
- Circular Externa 005 de 2017 (texto compilado): https://normograma.dian.gov.co/dian/compilacion/docs/circular_superindustria_0005_2017.htm
- Circular Externa 008 de 2017 (Japan adequacy): https://suin-juriscol.gov.co/viewDocument.asp?ruta=Circular/30035608
- Título V Circular Única SIC (data protection, 2020 consolidation): https://sedeelectronica.sic.gov.co/sites/default/files/normatividad/052020/T%C3%ADtulo%20V%20Proteccion%20Datos%20Circular%2003%20del%2030%20de%20marzo%202020).pdf
- Decreto 1297 de 2022 (texto): https://www.suin-juriscol.gov.co/viewDocument.asp?id=30044474 and https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=190426
- URF — Decreto 1297 de 2022: https://www.urf.gov.co/w/decreto-1297-de-2022
- URF — mandatory open finance announcement: https://www.urf.gov.co/w/colombia-consolida-el-sistema-de-finanzas-abiertas-obligatorio
- URF — technical document, mandatory open-finance decree (Feb 2026): https://www.urf.gov.co/documents/283253/0/20260220_002_Documento_te%CC%81cnico.pdf
- SFC — Circular Externa 001 de 2026 (texto): https://www.superfinanciera.gov.co/loader.php?lServicio=Tools2&lTipo=descargas&lFuncion=descargar&idFile=1080722
- SFC — laArenera (sandbox): https://www.superfinanciera.gov.co/publicaciones/10114254/innovasfclaarenerasandbox-regulatorio-10114254/
- SFC — concept 2024108013-005 (TRD requirements, via OCH Group repost): https://www.ochgroup.co/wp-content/uploads/2025/08/Finanzas-abiertas-requisitos-exigibles-a-las-entidades-vigiladas-que-actuen-com-Concepto-2024108013-005.pdf
- Decreto 1981 de 1988 (captación masiva): https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=75473
- Decreto 1234 de 2020 (sandbox): https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=142005

Legal/industry analyses (2024–2026):
- Holland & Knight — RNBD obligations 2025: https://www.hklaw.com/en/insights/publications/2025/01/obligaciones-del-registro-nacional-de-bases-de-datos-personales
- Deloitte — RNBD 2025: https://www2.deloitte.com/content/dam/Deloitte/co/Documents/legal/Registro-Nacional-de-Bases-de-Datos-2025.pdf
- Dentons Cárdenas & Cárdenas — RNBD 2025: https://dentons.cardenas-cardenas.com/es/insights/articles/2025/february/6/obligations-regarding-the-national-database-registry-2025
- Nomikos — RNBD obligations 2026 (UVT figure): https://nomikos.com.co/registro-nacional-de-bases-de-datos-rnbd-obligaciones-clave-para-2026-en-colombia/
- Holland & Knight — Decreto 0368 de 2026 analysis: https://www.hklaw.com/en/insights/publications/2026/04/nuevo-decreto-incorpora-el-sistema-de-finanzas-abiertas-en-colombia
- Holland & Knight — SFC CE 004 de 2024 analysis: https://www.hklaw.com/en/insights/publications/2024/03/la-sfc-expide-regulacion-sobre-las-finanzas-abiertas-en-colombia
- Holland & Knight — CE 001 de 2026 deadline extension: https://www.hklaw.com/en/insights/publications/2026/02/sfc-amplia-el-plazo-para-que-entidades-en-colombia-se-ajusten
- Pérez-Llorca — CE 001 de 2026 transition regime: https://www.perezllorca.com/es-co/actualidad/boletin/regimen-de-transicion-a-modelo-de-finanzas-abiertas-circular-externa-001-de-2026-de-la-superfinanciera-de-colombia/
- Cuéllar Abogados — Decreto 0368 de 2026: https://cuellar-abogados.com/decreto-0368-de-2026-colombia-establece-las-finanzas-abiertas-obligatorias/
- Forbes Colombia — mandatory open finance (Apr 2026): https://forbes.co/2026/04/10/economia-y-finanzas/colombia-obligara-a-todos-los-bancos-a-compartir-datos-de-clientes/
- LatamFintech — fintech licensing overview: https://www.latamfintech.co/articles/debo-tener-una-licencia-especial-en-colombia-para-operar-mi-negocio-en-fintech
- Fiskil — Colombia open-finance compliance guide: https://www.fiskil.com/es/open-finance/colombia
- Sensedia — CE 004/2024 standards summary: https://www.sensedia.com.es/post/colombia-define-las-reglas-y-estandares-generales-para-el-open-finance
- Facephi — Decreto 0368 overview: https://facephi.com/observatory/finanzas-abiertas-en-colombia-decreto-0368/
- Garrigues — sandbox Decreto 1234: https://www.garrigues.com/es_ES/garrigues-digital/colombia-expide-normativa-relacionada-denominado-espacio-controlado-prueba-o
