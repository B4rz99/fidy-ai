# Natural-person Subscription IVA and electronic-invoicing determination

- **Issue:** [#224](https://github.com/B4rz99/fidy-ai/issues/224)
- **Research date:** 2026-08-13
- **Status:** **Professional determination still required; do not release billing from this report alone.**

## Question and boundary

Fidy will sell one Pro Subscription to Colombian consumers at gross COP prices of 9,900 weekly, 28,900 monthly, and 289,900 yearly. The merchant is presently intended to be the owner's Colombian natural-person business using Wompi. A `PriceRevision` must retain the exact price, billing period, ServiceMarket, and tax treatment, while each `BillingAttempt` retains the charge and provider history ([Fidy domain definitions](../../CONTEXT.md#L237-L252); [parent specification](https://github.com/B4rz99/fidy-ai/issues/1); [checkout ticket #36](https://github.com/B4rz99/fidy-ai/issues/36)).

This report traces the governing primary sources and defines the decision and implementation artifacts. It **cannot complete the legal conclusion requested by #224** because the repository does not contain the owner's current RUT, complete person-wide tax facts, signed customer terms, actual Wompi merchant agreement, or a review by a Colombian accountant or tax adviser. Those are facts the law makes outcome-determinative, not details that can be inferred from the words “natural person,” “SaaS,” or from projected Fidy revenue.

## Executive determination

1. **Fidy's service classification is unresolved.** Colombian law generally taxes services supplied in Colombia, at 19% absent a specific exception. Article 476(21) separately excludes qualifying supply of web pages, hosting, and cloud computing. DIAN recognizes SaaS as a cloud service model, but requires the actual supply to satisfy the cloud characteristics plus service and deployment models. Calling the product SaaS is not enough. Bundled non-cloud services must be classified separately. ([ET arts. 420(c), 468 and 476(21)](https://normograma.dian.gov.co/dian/compilacion/docs/estatuto_tributario.htm#420); [DIAN Concept 17056/2017](https://normograma.dian.gov.co/dian/compilacion/docs/concepto_tributario_dian_0017056_2017.htm); [DIAN Concept 001959/2024](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_1959_2024.htm); [DIAN Concept 013328/2025, paras. 3–8](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_13328_2025.htm))
2. **The owner's IVA responsibility is a separate decision.** If Fidy is taxable, a natural person avoids registration and collection only while **all** Article 437(3) conditions hold. Those conditions cover current/prior-year taxable activity, establishments, intangible-exploitation arrangements, customs status, individual/aggregated contracts, and financial inflows from taxable activity. Revenue is only one condition. If Fidy is excluded, no IVA is charged on that supply, but other person-wide taxable activities and the separate invoicing rules still matter. ([ET art. 437(3)](https://normograma.dian.gov.co/dian/compilacion/docs/estatuto_tributario.htm#437))
3. **Natural-person form does not itself remove electronic invoicing.** A responsible-for-IVA seller is obligated. A natural person satisfying Article 437(3) is not obligated; a natural person supplying only excluded/non-taxed services is also not obligated while relevant gross income remains below 3,500 UVT. Once the exception does not apply, the general duty covers service providers regardless of taxpayer status, and paper invoices are only a contingency form. ([ET arts. 615 and 616-1](https://normograma.dian.gov.co/dian/compilacion/docs/estatuto_tributario.htm#615); [Decree 1625 arts. 1.6.1.4.2–1.6.1.4.3](https://normograma.dian.gov.co/dian/compilacion/docs/decreto_1625_2016.htm#1.6.1.4.2); [Resolution 227 arts. 1.5.1.1.3.3–1.5.1.1.3.4](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0227_2025.htm#1.5.1.1.3.3))
4. **No launch `PriceRevision` has an approved tax identity yet.** Until the professional review chooses one legal branch and signs the examples, code must not hard-code `19%`, `excluded`, a zero-rate surrogate, an IVA split, or a Wompi tax detail.
5. **The three consumer prices remain gross and final in every branch.** Colombian consumer-price guidance requires advertised prices to include applicable taxes and charges. A future IVA responsibility change therefore creates new future `PriceRevision`s even if Fidy keeps the advertised gross prices unchanged. ([SIC public-price guidance](https://sedeelectronica.sic.gov.co/temas/proteccion-al-consumidor/derechos-y-deberes/inconvenientes-precio))

## 1. Legal decision matrix

The service classification and seller status must be represented independently.

| Actual reviewed facts                                                                                     | Service treatment                        | Seller treatment for this supply                                         | Consumer split                                                              | Wompi IVA detail                                                                           | Invoice consequence                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Fidy satisfies the cloud criteria and the paid supply contains no separately supplied non-cloud component | **Excluded**, ET 476(21), not “0%-rated” | IVA is not collected on the excluded supply                              | `base = gross`, `tax = 0`                                                   | Omit                                                                                       | Apply the excluded-only invoicing threshold/status test below                                                                   |
| Fidy is a taxable service, but the owner satisfies **every** ET 437(3) condition                          | **Taxable at 19% by nature**             | Owner is currently **not responsible for IVA**, so must not add IVA      | `base = gross`, `tax = 0`; retain “taxable/non-responsible,” not “excluded” | Omit                                                                                       | Natural-person exception normally means no invoice duty unless the owner voluntarily becomes a facturer or another duty applies |
| Fidy is taxable and the owner fails any ET 437(3) condition or is already registered as responsible       | **Taxable at 19%**                       | Owner must collect, invoice, declare, and pay IVA                        | Gross-inclusive 19% split                                                   | Send exact IVA only if the actual Wompi charge endpoint and merchant arrangement accept it | Electronic invoice for each sale/service, with IVA discriminated                                                                |
| The paid supply contains separately classifiable excluded and taxable services                            | **Mixed**                                | Determine responsibility from the taxable activity and person-wide facts | Adviser-approved line allocation; only taxable lines generate IVA           | Send the sum of IVA only if provider support is confirmed                                  | Invoice lines preserve each component and treatment                                                                             |

**Why “taxable but non-responsible” is not “excluded”:** Article 420 determines whether the transaction is within IVA; Article 476 determines exclusions; Article 437 determines who must register as responsible. Collapsing these into a single numeric `rate = 0` destroys the legal reason and makes a later responsibility change impossible to explain. ([ET arts. 420, 437 and 476](https://normograma.dian.gov.co/dian/compilacion/docs/estatuto_tributario.htm#420))

### 1.1 Cloud/SaaS review that must be performed

DIAN's unified cloud doctrine requires five characteristics—on-demand self-service, broad network access, resource pooling, rapid elasticity, and measured service—plus a recognized service model and deployment model. DIAN's later doctrine identifies SaaS as a recognized model and says the exclusion belongs to the provider that actually supplies the qualifying cloud service. A reseller or intermediary receives the exclusion only when it itself meets the provider/model criteria. ([DIAN Concept 17056/2017, conclusions 1–4](https://normograma.dian.gov.co/dian/compilacion/docs/concepto_tributario_dian_0017056_2017.htm); [DIAN Concept 001959/2024](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_1959_2024.htm))

The reviewer must map those criteria to evidence, not labels:

- Fidy's customer terms and price page: what exactly is supplied for the Subscription;
- how users receive and automatically scale access to the hosted application;
- resource pooling, elasticity, measurement, and deployment evidence in Fidy's actual infrastructure;
- whether WhatsApp access, hosted analysis, statement workflows, recurring intelligence, support, or any other paid item is one cloud service or a separately supplied component;
- whether any component is a software licence/authorization rather than a qualifying cloud supply.

DIAN says packaged services must be discriminated by their own nature and the cloud exclusion cannot be extended to a different service merely because it is related to cloud computing. That makes the customer contract and commercial presentation decisive for the “mixed” branch. ([DIAN Concept 013328/2025, paras. 6–8](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_13328_2025.htm))

A second unresolved risk is Article 437(3)(3): the non-responsible exception requires that the business not operate under a franchise, concession, royalty, authorization, or another system involving exploitation of intangibles. DIAN doctrine treats permission to use software without transfer of the patrimonial rights as software licensing/exploitation. A tax adviser must determine whether Fidy's consumer Subscription is such an arrangement and therefore independently defeats the non-responsible exception if the service is taxable. ([ET art. 437(3)(3)](https://normograma.dian.gov.co/dian/compilacion/docs/estatuto_tributario.htm#437); [DIAN Office 015674/2012](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_15674_2012.htm))

### 1.2 Natural-person responsibility review

For taxable supplies, Article 437(3) requires all of these to remain non-responsible:

1. taxable-activity gross income below 3,500 UVT in both the prior and current year;
2. no more than one establishment, office, site, premises, or business where the activity is exercised;
3. no franchise, concession, royalty, authorization, or other intangible-exploitation arrangement there;
4. not a customs user;
5. no individual taxable contract at or above 3,500 UVT in the prior/current year, including multiple contracts with the same contractor that together cross the threshold; and
6. taxable-activity bank deposits/investments not above 3,500 UVT in the prior/current year.

These are the current statutory conditions; the RUT and supporting facts must establish each one. ([ET art. 437(3)](https://normograma.dian.gov.co/dian/compilacion/docs/estatuto_tributario.htm#437))

For orientation only, 2026 UVT is COP 52,374, so 3,500 UVT is COP 183,309,000. The 2025 UVT was COP 49,799, so the prior-year arithmetic is COP 174,296,500. These amounts are **not a stand-alone safe harbour** because every other condition still applies. ([DIAN Resolution 238/2025](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0238_2025.htm); [DIAN Resolution 193/2024](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0193_2024.htm))

The review must use the natural person's complete activity—not only Fidy—and answer:

- current RUT activities, responsibilities, SIMPLE status, and existing electronic-facturer status;
- other taxable/excluded/exempt activities and their current/prior-year income;
- relevant contracts and taxable bank inflows;
- all establishments/offices and customs-user status;
- whether any existing or Fidy arrangement exploits intangibles;
- expected 2026–2027 Subscription sales and the exact monitoring event that triggers an update.

## 2. RUT and electronic-invoicing consequences

### 2.1 RUT actions after the professional decision

The RUT classification includes activities and tax responsibilities. An update is due no later than one month after the event causing it. ([Decree 1625 arts. 1.6.1.2.5 and 1.6.1.2.14](https://normograma.dian.gov.co/dian/compilacion/docs/decreto_1625_2016.htm#1.6.1.2.14))

The adviser must produce an explicit change list against the actual RUT:

- approved primary/secondary CIIU activity code(s) for the supplied Fidy service;
- retain/add/remove **48 — responsible for IVA** or **49 — not responsible for IVA**, as legally applicable;
- add/verify **52 — electronic facturer** if invoicing is obligatory or voluntarily adopted;
- identify every other responsibility affected by the owner's actual regime.

DIAN's official RUT responsibility list defines codes 48, 49, and 52. Habilitation as an electronic facturer adds code 52 automatically at the selected production start date. ([DIAN responsibility list](https://www.dian.gov.co/impuestos/RUT/Paginas/Responsabilidades-y-Usuarios-Aduaneros.aspx); [DIAN RUT/e-invoice guidance](https://micrositios.dian.gov.co/sistema-de-facturacion-electronica/rut-en-factura-electronica/))

**No CIIU or responsibility change is approved by this research.** Choosing one without the current RUT and adviser review would recreate the inference #224 forbids.

### 2.2 When an invoice is required

| Reviewed state                                                                                                      | Duty                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Owner is responsible for IVA                                                                                        | Must invoice every operation; invoice electronically                                                                     |
| Owner satisfies ET 437(3) as a non-responsible natural person                                                       | Exception from invoice/document-equivalent duty                                                                          |
| Owner only supplies excluded/non-taxed services and gross income from them is below 3,500 UVT in prior/current year | Exception from invoice/document-equivalent duty                                                                          |
| Excluded-only owner crosses that 3,500-UVT invoicing exception, or another general obligation applies               | Must invoice, but does **not** invent IVA on the excluded service                                                        |
| Owner is in SIMPLE                                                                                                  | Must invoice                                                                                                             |
| Otherwise-not-obliged owner voluntarily habilitates                                                                 | Becomes a facturer from the selected start date and must comply prospectively; this is not a one-off per-customer option |

Sources: [Decree 1625 arts. 1.6.1.4.2–1.6.1.4.3](https://normograma.dian.gov.co/dian/compilacion/docs/decreto_1625_2016.htm#1.6.1.4.2); [Resolution 227 arts. 1.5.1.1.3.3–1.5.1.1.3.4](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0227_2025.htm#1.5.1.1.3.3); [DIAN Concept 011723/2025](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_11723_2025.htm).

For an obligated seller, an electronic invoice is only “issued” after DIAN validation and delivery to the buyer. Paper/talonario is valid only for the defined technological contingencies. The seller remains responsible even when using a platform or technology provider. ([ET art. 616-1](https://normograma.dian.gov.co/dian/compilacion/docs/estatuto_tributario.htm#616-1); [Decree 1625 art. 1.6.1.4.19](https://normograma.dian.gov.co/dian/compilacion/docs/decreto_1625_2016.htm#1.6.1.4.19))

### 2.3 Customer information and delivery

A named electronic invoice may request only:

- name/surname or legal name;
- identification type and number; and
- email, unless the buyer chooses a printed graphical representation.

If the buyer does not ask for a named invoice, those data must not be demanded for invoicing. The invoice schema permits `consumidor final` with `222222222222` when identification is not supplied. The payment provider may independently require payer data for payment/anti-fraud purposes, but Fidy must not misrepresent that as a DIAN invoice requirement. ([Resolution 227 arts. 1.5.1.12.3 and 1.5.1.2.2.1(3)](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0227_2025.htm#1.5.1.12.3))

For a non-electronic-facturer buyer, delivery may be by authorized email/electronic means or printed graphical representation. If no delivery means is selected, the rule points to printing. The invoice implementation therefore needs an explicit buyer delivery choice; a Wompi payment receipt is not a substitute. ([Resolution 227 art. 1.5.1.5.5.1](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0227_2025.htm#1.5.1.5.5.1))

Resolution 227 also says a facturer collecting named-invoice data must provide a direct, in-person channel for the buyer to supply it. The adviser should confirm how a web/WhatsApp-only launch must satisfy that current text before electronic invoicing goes live. ([Resolution 227 art. 1.5.1.12.3](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0227_2025.htm#1.5.1.12.3))

## 3. Exact candidate price facts and rounding

These are **branch-complete implementation examples, not approved tax advice**. The professional memo must select one branch (or supply a mixed allocation), approve the rounding policy, and attach its signed identity to each launch `PriceRevision`.

### 3.1 Excluded, or taxable while owner is non-responsible

The numeric result is the same, but the retained legal classification must differ.

| Period  |  Gross COP | Base/consideration COP | IVA COP | Wompi `VAT` detail |
| ------- | ---------: | ---------------------: | ------: | ------------------ |
| Weekly  |   9,900.00 |               9,900.00 |    0.00 | Omit               |
| Monthly |  28,900.00 |              28,900.00 |    0.00 | Omit               |
| Yearly  | 289,900.00 |             289,900.00 |    0.00 | Omit               |

An excluded treatment must retain `excludedCloud`, while a taxable supply sold by a non-responsible owner must retain `taxableGeneral + sellerNonResponsible`. Neither should send a fake zero-rate tax detail.

### 3.2 Taxable at 19% while owner is responsible

Proposed deterministic compatibility policy:

1. store gross in COP to two decimals;
2. compute `IVA = roundHalfEven(gross × 19 / 119, 2 decimals)`;
3. compute `base = gross − IVA`, so gross always reconciles exactly;
4. do not use the optional nearest-COP-10 approximation; and
5. convert Wompi values to integer centavos exactly.

| Period  |  Gross COP |   Base COP |   IVA COP | Wompi gross centavos | Proposed Wompi IVA centavos |
| ------- | ---------: | ---------: | --------: | -------------------: | --------------------------: |
| Weekly  |   9,900.00 |   8,319.33 |  1,580.67 |              990,000 |                     158,067 |
| Monthly |  28,900.00 |  24,285.71 |  4,614.29 |            2,890,000 |                     461,429 |
| Yearly  | 289,900.00 | 243,613.45 | 46,286.55 |           28,990,000 |                   4,628,655 |

The DIAN v1.9 technical annex specifies round-half-to-even for monetary validation and permits a `PayableRoundingAmount` when rounded partials differ. It also allows—but does not require—IVA to be approximated to the nearest COP 10. The proposed policy deliberately does not take that option, because cent-level values reconcile across Fidy, DIAN XML, and Wompi. ([DIAN Electronic Invoice Technical Annex v1.9, §5.2.1, pp. 14–15](https://www.dian.gov.co/impuestos/factura-electronica/Documents/Anexo-Tecnico-Factura-Electronica-de-Venta-vr-1-9.pdf); [Decree 1625 art. 1.3.1.1.1](https://normograma.dian.gov.co/dian/compilacion/docs/decreto_1625_2016.htm#1.3.1.1.1))

### 3.3 Mixed treatment

No exact mixed table can be computed from the three gross prices alone. The adviser must approve, for each period, exact gross allocations whose sum equals the advertised gross; only the taxable allocation is divided by 1.19. The invoice must preserve separate lines/treatments, while Wompi—if supported—receives only the total IVA detail. DIAN requires packaged services to be separately classified and electronic invoices to discriminate taxable lines and applicable rates. ([DIAN Concept 013328/2025](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_13328_2025.htm); [Resolution 227 art. 1.5.1.2.2.1(8), (13)](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0227_2025.htm#1.5.1.2.2.1))

## 4. Wompi boundary

Wompi Checkout documents `tax-in-cents` as optional informational detail inside—not added to—the transaction total. It accepts `VAT` and `CONSUMPTION`; its example is gross COP 119,000 = base 100,000 + IVA 19,000. ([Wompi Checkout, optional parameters and tax example](https://docs.wompi.co/docs/colombia/widget-checkout-web/#par%C3%A1metros-opcionales))

Two unresolved provider facts prevent an unconditional implementation decision:

1. The current generic transaction API documentation used for payment-source renewals lists mandatory/optional fields but does not list a tax object, while Checkout does. ([Wompi Transactions](https://docs.wompi.co/docs/colombia/transacciones/); [Wompi payment sources](https://docs.wompi.co/docs/colombia/fuentes-de-pago/))
2. Public documentation identifies Fidy as the merchant and promises Wompi payment receipts, but does not establish that Wompi becomes merchant of record or issues Fidy's DIAN sales invoice. The tax invoice duty remains with the seller unless the actual merchant contract says otherwise. ([Wompi Transactions](https://docs.wompi.co/docs/colombia/transacciones/); [Decree 1625 art. 1.6.1.4.19](https://normograma.dian.gov.co/dian/compilacion/docs/decreto_1625_2016.htm#1.6.1.4.19))

Required Wompi confirmation:

- legal merchant/seller named in the contract and settlement account;
- whether Checkout and **payment-source renewal transactions** accept and retain exact IVA centavos;
- whether the field changes acquiring/receipt behavior;
- whether Fidy or Wompi issues the DIAN invoice;
- provider refund/void support by card, Nequi, and DaviPlata, including partial refunds and asynchronous outcomes.

Implementation policy after confirmation:

- excluded or seller-non-responsible: omit Wompi IVA detail;
- responsible at 19%: send the approved exact IVA detail on every initial and renewal charge if that endpoint supports it;
- mixed: send only approved aggregate IVA;
- always retain `providerTaxDetail = omitted | sent(amount)` on the `BillingAttempt`; never infer it later from the provider response.

## 5. Causation, failures, cancellation, plan changes, and refunds

### 5.1 Causation and failed charges

For services, IVA is caused on the earliest of invoice issuance, completion of the service, or payment/credit to account—not merely on Wompi success. A responsible seller can therefore owe invoiced IVA even if the buyer never pays. ([ET art. 429(c)](https://normograma.dian.gov.co/dian/compilacion/docs/estatuto_tributario.htm#429); [DIAN Office 022062/2006](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_22062_2006.htm))

**Recommended product/accounting design, pending adviser approval:** paid access for a new period starts only after verified Wompi approval; generate and deliver the invoice at that activation boundary. A pending or failed charge with no new paid service and no invoice has no sales invoice or credit note. Dunning grace should be expressly documented as a free temporary access extension rather than an already-rendered paid renewal; otherwise service completion can cause IVA before collection. This recommendation aligns the asynchronous `BillingAttempt` model with tax causation but is a Fidy conclusion, not a quoted statutory rule.

### 5.2 Cancellation and plan changes

- Cancellation that only prevents future renewals and leaves the paid period intact does not alter the historical sale: no credit note.
- A plan change scheduled for the next renewal creates no current invoice correction; the future charge uses a new accepted `PriceRevision`.
- An immediate plan change that changes an already invoiced period must preserve the original invoice and use the adviser-approved correction: credit the decrease/refund against the original invoice and issue a new invoice for a new/increased supply where required. DIAN doctrine says a post-invoice value change requires the corresponding note, and current invoice rules preserve the referenced invoice/CUFE. ([DIAN Concept 013416/2025](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_13416_2025.htm); [Resolution 227 art. 1.5.1.5.6.1](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0227_2025.htm#1.5.1.5.6.1))

### 5.3 Refund and credit-note contract

A provider refund and a DIAN credit note are separate effects. For a full or partial rescission/refund of an invoiced operation:

1. retain the refund request, exact gross Money, provider transaction/refund references, and verified provider result;
2. generate a DIAN credit note that references the original invoice/CUFE and uses the original tax treatment and proportional gross/base/tax values;
3. validate it with DIAN and deliver it through the same channel as the invoice;
4. never delete or reuse the original invoice number; and
5. reflect the refund and IVA reversal in accounting and the IVA period in which the rescission/refund occurs.

Article 484 permits the original-rate IVA attributable to full or partial annulled/rescinded/resolved supplies to reduce generated IVA only when the event is properly supported in accounting. Resolution 227 makes the electronic credit note the cancellation mechanism, requires its invoice/CUFE references and exact line/tax values, and forbids adjusting one note with another. ([ET art. 484](https://normograma.dian.gov.co/dian/compilacion/docs/estatuto_tributario.htm#484); [Resolution 227 art. 1.5.1.5.6.1](https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0227_2025.htm#1.5.1.5.6.1))

The customer must receive the refunded gross attributable to the rescinded supply, including the IVA originally borne. DIAN doctrine states that an annulled paid taxable transaction must be reflected in accounting/declaration and returned to the user with its IVA. ([DIAN Office 066811/2005](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_66811_2005.htm))

The professional memo must still decide the operational ordering when a provider refund is asynchronous (for example, when the commercial rescission becomes final relative to provider approval) and the allocation policy for partial-period refunds. The public Wompi pages reviewed do not document a general cross-method refund API, so that provider behavior cannot be assumed.

## 6. Immutable implementation contract

### 6.1 `PriceRevision`

Each launch revision must point to an immutable, adviser-approved tax-treatment identity. At minimum preserve:

- `taxTreatmentId` and version;
- `serviceClassification`: `excludedCloud | taxableGeneral | mixed`;
- `sellerIvaStatus`: `responsible | nonResponsible`;
- legal-basis references and signed adviser-memo identifier/hash;
- exact gross Money and billing period;
- exact component allocation for mixed treatment;
- rate(s) as exact decimals/rationals, never floating point;
- rounding-policy identity;
- approved gross/base/tax example;
- Wompi detail policy: `omit | sendVat`;
- effective UTC instant and ServiceMarket.

A later service-classification, IVA-responsibility, allocation, or rounding change creates a new `PriceRevision` even when the advertised gross price is unchanged. The old revision is never rewritten.

### 6.2 Each successful billing-period charge

Snapshot, do not recompute:

- accepted `PriceRevisionId` and tax-treatment version;
- exact gross/base/IVA and any rounding adjustment;
- component splits for mixed treatment;
- seller RUT responsibility snapshot/evidence reference;
- whether Wompi tax detail was omitted or the exact centavos sent;
- BillingAttempt/provider transaction identifiers and verified timestamps;
- invoice number, CUFE, generation/validation/delivery timestamps, and delivery method where invoicing applies;
- explicit `invoiceNotRequiredReason` where it does not;
- refund and credit-note lineage without deleting the original charge.

A failed/pending `BillingAttempt` retains attempted Money and provider evidence but must not fabricate an invoice, tax collected, refund, or credit note.

### 6.3 Prohibited shortcuts

- no `rate = 0` without distinguishing excluded from non-responsible;
- no tax classification derived from `merchantType`, revenue alone, plan label, or “SaaS”;
- no current RUT lookup used to reinterpret old charges;
- no recomputation of historical base/tax using today's rate or responsibility;
- no Wompi receipt treated as a DIAN invoice;
- no provider refund treated as a credit note, or vice versa;
- no hard-coded 19% fallback when the approved treatment is absent.

## 7. Required professional sign-off packet

Provide a Colombian accountant/tax adviser with:

1. the unredacted current RUT and responsibility history;
2. current/prior-year person-wide activity, contracts, deposits, establishments, customs status, SIMPLE status, and other taxable/excluded supplies;
3. Fidy terms, price page, complete paid/free feature boundary, and the cloud-criteria evidence listed in §1.1;
4. projected sales flow by period and channel;
5. the actual Wompi merchant agreement, settlement party, enabled methods, tax-detail behavior, and refund terms;
6. the candidate tables and lifecycle rules in this report.

Require a dated written answer that:

- selects `excludedCloud`, `taxableGeneral`, or an exact mixed allocation;
- decides whether the owner is responsible for IVA now and names every monitored trigger;
- resolves the Article 437 intangible-exploitation condition;
- gives exact CIIU and RUT responsibility changes and deadlines;
- decides the electronic-invoice duty and start date;
- approves named-invoice/customer-data and delivery flow;
- approves one exact rounding policy and all three gross/base/tax examples;
- decides Wompi IVA detail separately for Checkout and automatic renewals;
- approves causation, dunning grace, cancellation, plan-change, refund, and credit-note handling; and
- assigns an immutable memo identity/hash to each launch `PriceRevision`.

## Unresolved questions / acceptance status

- **Unmet:** no Colombian accountant/tax adviser has reviewed the actual service, current RUT, expected sales, and Wompi agreement.
- **Unresolved:** excluded cloud/SaaS, taxable 19%, or exact mixed allocation.
- **Unresolved:** owner's current IVA responsibility, including Article 437(3)(3) intangible exploitation.
- **Unresolved:** exact CIIU/RUT changes and electronic-invoice start date.
- **Unresolved:** whether Wompi's automatic payment-source charge accepts the same IVA detail as Checkout and who the merchant contract names as invoice issuer.
- **Unresolved:** provider-specific full/partial refund capability and asynchronous ordering.
- **Pending approval:** the two-decimal half-even examples and the decision not to round IVA to COP 10.

Accordingly, #224 should remain open and billing implementation must keep the three launch tax-treatment identities in a non-releasable `pendingProfessionalApproval` state until the signed determination exists.
