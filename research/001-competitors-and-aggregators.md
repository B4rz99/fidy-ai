# 001 — Competitor & Aggregator Landscape in Colombia

- **Ticket:** tracker/tickets/001-research-competitors-and-aggregators.md
- **Researched:** 2026-07-22 (web sources, favoring 2025–2026 primary material)
- **Confidence labels:** claims are marked **[Confirmed]** (primary source or reputable press, cited) or **[Inference]** (my reading of the evidence).

---

## TL;DR

Aggregator-backed bank sync is **not a viable MVP baseline for consumer PFM in Colombia today**. Belvo — historically the strongest Colombian retail-bank aggregator — no longer lists any Colombian products on its developer portal or status page (Brazil/Mexico only, as of July 2026). Prometeo's public Colombia coverage is account *validation* and B2B payments/treasury, not consumer transaction history. Finerio Connect and Syncfy claim Colombia coverage but publish no Colombian bank list, no self-serve pricing, and no public reliability data. Mandatory open finance (Decreto 0368 of April 2026) will not produce working, mandated data APIs before **H2 2027 at the earliest**. Meanwhile, every PFM app actually operating in Colombia ingests data manually (or via voice/AI entry), and the one notable automatic-ingestion player in history (Bankity, 2014) did it by reading **bank transaction alerts/notifications** — not credentials. Layered manual + notification + statement ingestion is the realistic baseline; design the data layer so an aggregator or the 2027+ open-finance rails can be slotted in later.

---

## 1. Regulatory context (frames everything else)

- **[Confirmed]** Colombia's open-finance framework evolved: Decreto 1297 de 2022 (voluntary scheme) → Ley 2294 de 2023 art. 89 (National Development Plan, mandate basis) → SFC Circular Externa 004 de 2024 (technical/security/API standards) → SFC Circular Externa 009 de 2025 (extended the standards-compliance deadline to 2026-02-08) → **Decreto 0368 del 7 de abril de 2026**, which replaces the voluntary scheme with a **mandatory** open-finance system (modifies Decreto 2555 de 2010). Sources: URF, Superintendencia Financiera, Holland & Knight.
- **[Confirmed]** Decreto 0368's staggered timeline: SFC has until **October 2026** to publish the standards-issuance schedule, until **April 2027** to stand up the participant directory; entities then get **12 months (extendable +6)** to expose data once standards per data category are issued. Press and legal analyses conclude effective data-sharing will not occur before **H2 2027**, likely later for full coverage.
- **[Confirmed]** **Bre-B**, Banco de la República's interoperable instant-payment system (keys/"llaves", DICE directory + MOL settlement), went to full-scale operation on **2025-10-06**; 64.4M operations in its first month, ~3.6M/day by December 2025. Bre-B is a *payments* rail, not a data-sharing rail — but it standardizes account addressing (keys) and is already reflected in aggregator products (e.g., Prometeo validates Bre-B keys).
- **[Inference]** Pre-2027, third-party access to bank data rests on credential-based scraping under general data-protection/consent law (Ley 1581 de 2012 habeas data). It is not prohibited, but it is also not protected: banks may block scrapers with no recourse (see Fintonic vs. BancoEstado in Chile, a regional precedent).

---

## 2. Direct PFM competitors serving Colombia

### 2.1 Active local (Colombian) apps

| App | What it offers | Ingestion | Pricing | Traction |
|---|---|---|---|---|
| **Bolsillos** (bolsillos.app) | Envelope budgeting ("bolsillos") for freelancers/variable income; goals, reports; local-only encrypted data (no cloud) | **Manual + voice** (Pro); explicitly *no bank sync* — "Open Finance está en el roadmap para 2027" | Free tier (2 accounts, 50 tx/mo); Pro COP 199,900/yr; lifetime "Fundador" COP 799,900 | iOS only, Android waitlist — early stage **[Confirmed from site]** |
| **Gestiona Plus** (gestionaplus.com.co) | Budgets, debt payoff, savings; markets itself as "no exige claves bancarias" | **Manual** | 90 days free, then subscription | Unknown **[Confirmed features from site/blog]** |
| **MisFinanzasApp** | Expense/income tracking with **voice + AI natural-language entry** ("gasté 50.000 en almuerzo"), alerts, goals, LatAm currencies incl. COP | **Manual/voice-AI** | Freemium (details not published) | Unknown |
| **FinanzasFC / Finanfy** | Conventional expense trackers (categories, multiple accounts: cash/cards/banks/wallets) | **Manual** | Freemium | Unknown |
| **Tributi budget planner** | Free web budget planner from the tax-filing startup Tributi | **Manual** | Free (lead-gen for tax filing) | Unknown |

**[Inference]** The striking pattern: *no active Colombian PFM app offers automatic bank sync*. The local innovation axis is friction reduction on manual entry (voice, AI parsing, local-first privacy), and at least one (Bolsillos) explicitly pins bank connectivity to the 2027 open-finance timeline.

### 2.2 Regional/global apps used in Colombia

- **[Confirmed]** Colombian "best PFM apps" roundups (Portafolio, La República, las2orillas, 2025) consistently list **Fintonic, Monefy, Money Manager, Mobills, Wallet** — all manual-entry in Colombia.
- **[Confirmed]** **Fintonic** (Spain) is the region's flagship bank-connected PFM, but its operations are Spain + Mexico. It **shut down Chile in March 2023** ("nuestro viaje ha terminado"), citing funding costs and rate caps; in Chile it had also been **blocked by BancoEstado**, which it fought publicly. No evidence of a formal Colombian operation with local bank connections. **[Inference]** Its presence in Colombian app rankings reflects the app being downloadable, not local bank connectivity — in Colombia it is effectively another manual tracker, and its Chile exit is the regional cautionary tale for scraping-based PFM unit economics.
- **[Confirmed]** **Finerio** (Mexico) — the B2C PFM app that pioneered bank aggregation in Mexico — pivoted to B2B infrastructure (Finerio Connect, §3.3). Colombian press still occasionally recommends the app, but the company's business is now selling aggregation to banks. **[Inference]** Another datapoint that consumer PFM on scraped data did not sustain a business in LatAm.

### 2.3 Bank-native PFM (the incumbent substitute)

- **[Inference, medium confidence]** Bancolombia/Nequi, Davivienda/Daviplata and other large banks ship budgeting-ish features in-app (Nequi's "bolsillos"/goals; spending summaries in Bancolombia's app). They only see their own accounts, but they are the default "good enough" for most users and they own the transaction data. Finerio Connect claims a contract with "one of Colombia's largest banks (5M+ clients)" to power such features **[Confirmed claim by Finerio via Arkangeles/valoraanalitik]**.

### 2.4 Notable failures / pivots (Colombia-specific)

- **[Confirmed]** **Bankity** (Medellín, founded 2014): the closest historical analog to this project. Automatically tracked spending in real time **without bank credentials, by having users enable their bank's transaction alerts/notifications** — it worked with "any institution with per-transaction alerts" (Bancolombia, Davivienda, Citibank, Banco de Occidente, BBVA) and stored only last-4 digits (ENTER.CO, 2014). ~65k downloads across CO/MX/US by 2019; pivoted to a Visa card + digital-bank play; no activity found since — **[Inference]** effectively defunct or dormant.
- **[Confirmed]** **Fintonic Chile** shutdown (2023) and **Finerio B2C→B2B** pivot (above) — regional PFM failures relevant as pattern evidence, though not Colombian operations.

---

## 3. Aggregators / open-finance APIs with Colombian coverage

### 3.1 Belvo — the big negative finding

- **[Confirmed]** Belvo historically had the deepest Colombian retail coverage: Bancolombia, Nequi, Bancolombia a la Mano, Davivienda, Daviplata, Banco de Bogotá, Banco de Occidente, Scotiabank Colpatria, BBVA, AV Villas (per the Monet–Belvo lending case study), plus DIAN fiscal data, PILA employment data (launched May 2024), and PSE payment initiation (2023). Connection method for Colombian banks was **credential-based scraping** ("credentials" integration type in Belvo's API, vs "openfinance" used in Brazil).
- **[Confirmed]** As of **July 2026**, Belvo's developer portal (developers.belvo.com) lists products **only for Brazil (banking via Open Finance, employment, payments) and Mexico (employment IMSS, fiscal SAT, payments)**. Its institutions status page (institutions.belvo.com) shows **zero Colombian institutions**. Its April 2025 $15M raise was framed as "operating across Brazil and Mexico."
- **[Inference, high confidence]** Belvo wound down its Colombian product line sometime between mid-2024 and mid-2026, without a public sunset announcement I could find. Whatever the internal reason (scraping fragility, unit economics, waiting out the mandate), the market leader exiting Colombian credential aggregation is the single strongest signal against building an MVP on it.

### 3.2 Prometeo (Uruguay)

- **[Confirmed]** B2B-focused fintech infrastructure: account validation, treasury/banking data, cross-border A2A payments; 1,500+ connections, 11 countries; Colombia clients include Rappi and Mesfix; historically connected Bancolombia, Banco de Bogotá, Davivienda for data.
- **[Confirmed]** Its public docs' Colombia country page covers **Account Validation only**: validates local accounts (CC/NIT), **Nequi wallets**, and **Bre-B keys**, claiming "cobertura del 80% de las cuentas bancarias del país." Banking-data endpoints (accounts/movements/credit cards) exist in the API reference, but Colombia is not documented as a data-aggregation market. Free sandbox; quote-based pricing (no public rates); no first-party TypeScript SDK found in docs.
- **[Confirmed]** 2025: announced a Prometeo–Fiskil alliance to sell **compliance-side** open-finance tooling to Colombian regulated entities (consent management, directory integration) — i.e., positioned for the *bank* side of Decreto 0368, not for consumer PFM data access today.
- **[Inference]** Prometeo could plausibly deliver consumer movements for 2–3 big Colombian banks under a commercial agreement, but the product is aimed at corporate treasury/validation; consumer-grade recurrent refresh for a PFM is not its published use case.

### 3.3 Finerio Connect (Mexico)

- **[Confirmed]** "Full-stack" open-banking + PFM API: aggregation, categorization/enrichment, white-label PFM widgets, "Open Finance in a Box" (with Visa and Ozone API); 120+ clients in "México y LATAM"; claims a 98% connection success rate; claims a contract with a top Colombian bank (5M+ clients); raised US$6.5M citing LatAm expansion.
- **[Confirmed]** Publishes **no Colombian bank coverage list, no pricing, no self-serve developer signup** — everything routes through a sales contact form.
- **[Inference]** Their Colombian business is selling PFM/categorization *to banks*, not selling consumer aggregation to startups. A small MVP would face an enterprise sales cycle with unknown coverage and cost.

### 3.4 Syncfy / Paybook (Mexico)

- **[Confirmed]** Open-finance aggregation API (125+ institutions, ~15 countries claimed); coverage page lists Colombia among 6 covered countries, but the published institution detail is Mexico-only; raised US$10M seed (Dec 2022) earmarking expansion to Brazil/Colombia/Argentina.
- **[Inference]** Colombian coverage is thin/unverifiable from public material; connection method for any Colombian banks would be credential scraping.

### 3.5 Palenca (Mexico)

- **[Confirmed]** **Employment/payroll data, not bank data**: gig platforms (Uber, Rappi, DiDi, inDriver…), HR systems, government databases; operates in Colombia with all gig integrations; clients there include Abaco and Galgo; YC S21, Experian Ventures investment.
- **[Inference]** Irrelevant for transaction sync; potentially useful later for income verification of gig-worker users.

### 3.6 Minka (Bogotá)

- **[Confirmed]** Payments *infrastructure*, not aggregation: built Transfiya with ACH Colombia (real-time transfers, ~80% of accounts reachable, 2M users by 2022; $24M from Tiger/Kaszek), and now supports ACH's transition to **Bre-B**.
- **[Inference]** Not a data source for PFM. Relevant only if the product later initiates payments.

### 3.7 Not in Colombia

- **[Confirmed/Inference]** Fintoc (Chile/Mexico), Floid (Chile), Klavi (Brazil), Plaid, Tink: no Colombian consumer-bank coverage found.

### 3.8 Cross-cutting assessment

- **Connection method:** every Colombian bank connection that has ever existed commercially (Belvo, Prometeo data, Syncfy) is **credential-based scraping**; there are no bank-published data APIs for third parties yet (voluntary scheme saw near-zero adoption — that is *why* Decreto 0368 exists). **[Confirmed for Belvo's method; Inference for the rest]**
- **Reliability reputation:** scraping in LatAm has a documented pattern of bank blocking (BancoEstado vs Fintonic/Chile), MFA breakage, and silent institution removals (Belvo's Colombian catalog disappearing). No aggregator publishes Colombia-specific uptime. **[Confirmed examples; Inference as pattern]**
- **Pricing:** none of the four data aggregators publishes Colombian pricing; all are quote-based B2B sales. Belvo (the only one that ever had self-serve + published docs for CO) is gone. **[Confirmed]**
- **Developer/TypeScript experience:** Belvo had the best DX (OpenAPI spec, widgets, SDKs) — now BR/MX only. Prometeo has decent docs + free sandbox but Python-first, no official TS SDK found. Finerio Connect and Syncfy have no self-serve path. **[Confirmed for docs existence; Inference on comparative quality]**
- **Legal standing:** pre-Decreto-0368 scraping operates on user consent under habeas-data law; permitted but unprotected, and the mandatory system will define the *sanctioned* channel from ~2027. An MVP built on scraping would carry both technical and regulatory-transition risk. **[Inference]**

---

## 4. Verdict

**Aggregator-backed sync is not viable as the MVP baseline.** The evidence:

1. **The market leader exited.** Belvo — the only aggregator with broad, documented, self-serve Colombian retail coverage — now serves Brazil and Mexico only (developer portal + status page, July 2026). **[Confirmed]**
2. **No remaining option offers documented consumer transaction coverage.** Prometeo's public Colombia product is account validation (+ Bre-B keys); Finerio Connect and Syncfy claim coverage but publish no bank list, pricing, or self-serve access — enterprise sales cycles with unverifiable coverage. **[Confirmed/Inference]**
3. **Everything that exists is scraping**, which banks may block at will, and which the incoming mandatory regime will supersede — a fragile foundation exactly when the ground is shifting. **[Inference from confirmed facts]**
4. **Regulated APIs arrive ~H2 2027 at the earliest** (Decreto 0368 timeline: standards schedule Oct 2026, directory Apr 2027, +12–18 months for entity compliance). **[Confirmed]**
5. **The market itself validates the manual baseline**: every active PFM app in Colombia is manual/voice-entry, and the strongest historical automatic-ingestion play (Bankity) used **bank alert notifications**, proving that channel works across Bancolombia, Davivienda, BBVA, et al. without credentials. **[Confirmed]**

**Recommended baseline:** layered ingestion — (a) fast manual/voice/AI entry, (b) device-side parsing of bank notifications/SMS/emails (the Bankity channel, now easier with LLMs), (c) statement/CSV/PDF import for backfill. Architect an ingestion-source abstraction so a commercial aggregator (if Prometeo/Finerio materializes a consumer data product) or the mandatory open-finance APIs (2027+) become an additional source, not a rewrite. Track Decreto 0368 standards milestones (Oct 2026, Apr 2027) as the trigger for revisiting aggregators — being open-finance-ready at the moment the rails open is a plausible differentiator — local competitors (e.g., Bolsillos, which publicly targets open finance "2027" on its site) are betting the same way.

---

## Sources

### Regulation
- URF — "Colombia consolida el Sistema de Finanzas Abiertas obligatorio": https://www.urf.gov.co/w/colombia-consolida-el-sistema-de-finanzas-abiertas-obligatorio
- Superintendencia Financiera — press release on mandatory open finance: https://www.superfinanciera.gov.co/publicaciones/10116081/finanzas-abiertas-obligatorias-impulsaran-el-desarrollo-del-sistema-y-la-inclusion-financiera-en-el-pais/
- Holland & Knight — Decreto 0368 de 2026 analysis: https://www.hklaw.com/en/insights/publications/2026/04/nuevo-decreto-incorpora-el-sistema-de-finanzas-abiertas-en-colombia
- Holland & Knight — CE 009/2025 deadline extension: https://www.hklaw.com/en/insights/publications/2025/08/finanzas-abiertas-en-colombia-sfc-amplia-el-plazo
- Cuellar Abogados — Decreto 0368 de 2026: https://cuellar-abogados.com/decreto-0368-de-2026-colombia-establece-las-finanzas-abiertas-obligatorias/
- Forbes Colombia — mandatory data-sharing decree: https://forbes.co/2026/04/10/economia-y-finanzas/colombia-obligara-a-todos-los-bancos-a-compartir-datos-de-clientes/
- Fiskil — Colombia open finance compliance guide: https://www.fiskil.com/es/open-finance/colombia
- Banco de la República — Bre-B: https://www.banrep.gov.co/es/bre-b ; technical doc (Feb 2026): https://d1b4gd4m8561gs.cloudfront.net/sites/default/files/publicaciones/archivos/documento-tecnico-bre-b-febrero-2026.pdf
- Infobae — Bre-B launch delays: https://www.infobae.com/colombia/2025/08/27/banco-de-la-republica-aplazo-el-lanzamiento-del-sistema-de-pagos-inmediatos-bre-b-cual-es-la-nueva-fecha/

### Aggregators
- Belvo developer portal (BR/MX only, checked 2026-07-22): https://developers.belvo.com/
- Belvo institutions status page (no CO institutions, checked 2026-07-22): https://institutions.belvo.com
- Belvo institutions API spec (integration types credentials/openfinance): https://developers.belvo.com/apis/belvoopenapispec/institutions
- Belvo $15M raise, BR/MX framing (Apr 2025): https://fintech.global/2025/04/17/latin-american-fintech-belvo-raises-15m-to-scale-open-finance-platform/
- Monet + Belvo Colombia case (bank list): https://www.latamfintech.co/articles/fintechs-monet-y-belvo-revolucionan-el-acceso-al-credito-en-colombia-a-traves-del-open-finance
- Belvo employment data (PILA) launch in Colombia (2024): https://www.openbankingexpo.com/news/belvo-launches-employment-data-solution-in-colombia/
- Belvo direct debit / recurring payments CO+MX: https://belvo.com/blog/belvo-introduces-variable-recurring-payments-colombia-mexico-direct-debit/
- Prometeo docs — Colombia (Account Validation, Nequi, Bre-B keys): https://docs.prometeoapi.com/docs/colombia-av
- Prometeo docs — coverage index: https://docs.prometeoapi.com/docs/cobertura ; sandbox: https://docs.prometeoapi.com/docs/c%C3%B3mo-comenzar-a-utilizar-nuestro-sandbox
- Prometeo–Fiskil alliance for Colombia compliance: https://prometeoapi.com/blog/alianza-prometeo-fiskil
- Prometeo A2A payments in Colombia (Bloomberg Línea, 2022): https://www.bloomberglinea.com/2022/08/22/fintech-de-open-banking-prometeo-habilita-pagos-cuenta-a-cuenta-en-latinoamerica/
- Finerio Connect site (products, 98% claim, no CO bank list): https://finerioconnect.com/
- Finerio Connect US$6.5M raise + Colombian bank contract claim: https://www.valoraanalitik.com/finerio-connect-recauda-us-6-5-millones-para-apoyar-la-inclusion-financiera-en-la-region/
- Finerio Connect + Visa + Ozone API hub: https://blog.finerioconnect.com/finerio-connect-ozone-api-y-visa-colaboran-para-facilitar-la-banca-abierta-a-instituciones-financieras-en-america-latina-y-el-caribe/
- Syncfy coverage page: https://syncfy.com/en/coverage/ ; Syncfy US$10M seed (Bloomberg Línea): https://www.bloomberglinea.com/2022/12/08/syncfy-cierra-ronda-semilla-por-us10-millones-para-su-negocio-de-open-finance/
- Palenca blog (Colombia expansion, gig integrations): https://blog.palenca.com/
- Minka / Transfiya / Bre-B transition: https://minka.io/ ; TechCrunch $24M round: https://techcrunch.com/2022/04/27/bogota-based-minka-lands-24m-from-tiger-kaszek-to-build-an-open-infrastructure-for-money

### PFM competitors
- Bolsillos (features, pricing, 2027 open-finance roadmap): https://www.bolsillos.app/
- Gestiona Plus blog — "mejor app de finanzas personales Colombia 2026": https://gestionaplus.com.co/blog/mejor-app-de-finanzas-personales-colombia-2026
- MisFinanzasApp: https://www.misfinanzasapp.com/ ; FinanzasFC: https://finanzafc.com/ ; Tributi planner: https://www.tributi.com/finanzas-personales/planeador-de-presupuesto-y-finanzas-personales
- Bankity notification-based ingestion (ENTER.CO, 2014): https://www.enter.co/startups/innovacion/bankity-una-app-que-lleva-tus-gastos-sin-que-tengas-que-hacer-nada/
- Bankity profile (65k downloads, card pivot): https://panamericanworld.com/revista/startups/bankity-startup/
- Fintonic Chile shutdown (Diario Financiero, 2023): https://www.df.cl/mercados/banca-fintech/nuestro-viaje-ha-terminado-fintech-espanola-fintonic-cierra-sus
- Fintonic vs BancoEstado blocking: https://www.fintechile.org/noticias/jose-gabriel-carrasco-lider-de-fintonic-para-a-latina-mientras-en-chile-nos-bloquea-banco-estado-en-mexico-batimos-record-de-usuarios-todo-el-tiempo ; LexLatin: https://lexlatin.com/noticias/bancoestado-acuerdo-fintech-bloqueo
- App roundups (Portafolio / La República / las2orillas, 2025): https://www.portafolio.co/mis-finanzas/ahorro/top-5-apps-gratuitas-para-optimizar-y-medir-tus-finanzas-personales-615067 ; https://www.larepublica.co/finanzas-personales/las-aplicaciones-que-le-ayudan-a-organizar-el-presupuesto-y-sus-finanzas-4437993 ; https://www.las2orillas.co/estas-son-las-5-mejores-apps-para-administrar-sus-finanzas-personales-y-evitar-gastos-innecesarios/
- Colombia Fintech sector reports (ecosystem stats, PFM vertical): https://colombiafintech.co/fintech-snapshot-informe-sectorial-2025-2/
