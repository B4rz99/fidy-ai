# Wompi recurring enrollment, payment methods, and Colombia tax treatment

## Question

What must Fidy resolve before implementing the Wompi checkout and automatic-renewal path in [#36](https://github.com/B4rz99/fidy-ai/issues/36) and [#37](https://github.com/B4rz99/fidy-ai/issues/37), and which payment and tax assumptions are safe to encode?

## Executive conclusion

1. **Ordinary Wompi Web Checkout is not the documented recurring-enrollment flow.** Wompi documents automatic future charges through payment sources, after a separate tokenization and authorization flow. Fidy therefore needs an explicit recurring-enrollment design and merchant-account confirmation before #36 can safely claim automatic renewal.
2. **The recurring enrollment requires a web UI.** Direct payment-source creation requires payer data, current Wompi contract links, two explicit acceptances, and method-specific authorization. Card/account details must go directly from the browser to Wompi, never through Fidy's chat or API.
3. **Wompi supports more methods than Fidy's launch scope.** The documented set includes cards, Bancolombia transfer, Nequi, PSE, Bancolombia correspondent cash, Puntos Colombia, Bancolombia BNPL, DaviPlata, and SU+ Pay; Bancolombia QR is also documented. Only methods with a confirmed reusable payment-source path should be offered for an automatically renewing Subscription.
4. **Fidy's IVA classification is not safe to infer from “SaaS = 19%.”** DIAN doctrine recognizes qualifying SaaS as a cloud-computing model that may fall under the Article 476 exclusion, but only when the provider and service satisfy the required cloud characteristics/model criteria. A Colombian tax professional must classify Fidy's actual service and invoicing obligations before code freezes a rate or tax split.

## Provider findings

### Ordinary checkout versus automatic charges

Wompi Web Checkout accepts server-owned transaction facts—public key, COP amount in cents, unique reference, integrity signature, optional expiration, optional tax detail, and redirect information. The redirect is informational rather than proof of payment. The checkout documentation describes collecting a transaction; it does not say that checkout creates a reusable payment source. [Wompi: Widget & Checkout Web](https://docs.wompi.co/docs/colombia/widget-checkout-web/)

Wompi's automatic-payment documentation instead gives a three-step flow:

1. tokenize/authorize a card or account;
2. create a payment source with `POST /v1/payment_sources` using the private key on the server; and
3. create later transactions using `payment_source_id`.

Wompi explicitly warns merchants not to retain sensitive card, Nequi, DaviPlata, or other payment information. [Wompi: Payment sources and tokenization](https://docs.wompi.co/docs/colombia/fuentes-de-pago/)

**Conclusion:** returning an ordinary hosted-checkout URL is insufficient evidence that #37 can renew automatically. The merchant-specific aggregator arrangement must be confirmed with Wompi, and #36 must either own or depend on a recurring payment-source enrollment flow.

### What recurring enrollment asks of the User

For API-created transactions and payment sources that collect personal data, Wompi requires two tokens:

- `acceptance_token`, for the current end-user policy; and
- `accept_personal_auth`, for personal-data processing authorization.

The merchant must fetch the current pre-signed contract metadata, show both contract links, and obtain explicit acceptance of both—Wompi suggests separate checkboxes—before submitting the tokens. [Wompi: Acceptance tokens](https://docs.wompi.co/docs/colombia/tokens-de-aceptacion/)

Creating a payment source also requires the payer's email. Method-specific enrollment additionally requires:

- **Card:** browser-side card tokenization; Fidy's server should receive only the token and later payment-source id.
- **Nequi:** the User's Nequi phone number and approval of the subscription in the Nequi app before the token becomes `APPROVED`.
- **DaviPlata:** document type/number, product phone number, and OTP authorization; Wompi says production use requires commercial activation.
- **Bancolombia transfer:** a documented token/account-selection authorization and reusable payment source.

[Wompi: Payment sources and tokenization](https://docs.wompi.co/docs/colombia/fuentes-de-pago/)

**Conclusion:** this belongs on Fidy's authenticated upgrade web page, not in chat. Fidy should persist the minimum audit evidence and resulting payment-source id, but not card/account details, OTPs, Wompi acceptance tokens, or raw provider responses.

### Supported payment methods

Wompi's payment-method documentation lists:

- credit/debit cards (Visa, Mastercard, and American Express with CVC);
- Bancolombia transfer;
- Nequi;
- PSE;
- cash at Bancolombia banking correspondents;
- Puntos Colombia;
- Bancolombia buy-now-pay-later;
- DaviPlata; and
- SU+ Pay.

The same documentation also describes Bancolombia QR. Every method is asynchronous; a newly created transaction starts at `PENDING`. [Wompi: Payment methods](https://docs.wompi.co/docs/colombia/metodos-de-pago/)

**Conclusion:** support by Wompi does not imply suitability for Fidy. Cash, PSE, points, QR, and BNPL are poor defaults for automatic renewal unless Wompi confirms a reusable authorization. The parent spec currently names card, Nequi, and DaviPlata, so the MVP should not silently expose other merchant-enabled methods. A direct enrollment UI gives Fidy control over this set; the public checkout parameters do not document a payment-method allowlist. [Wompi: Widget & Checkout Web](https://docs.wompi.co/docs/colombia/widget-checkout-web/)

### One checkout can produce multiple Wompi transactions

After a failed payment, Wompi can offer a three-minute retry with another payment method. The first declined transaction and second approved transaction can have the same merchant reference, while each has a distinct Wompi transaction id. Both are reported to the webhook. [Wompi: Payment retry](https://docs.wompi.co/docs/colombia/reintento-de-pago/)

**Conclusion:** a Fidy `BillingAttempt` should represent one checkout/reference and retain multiple provider-transaction observations. Recommended aggregate rules:

- remain `pending` during the documented three-minute retry opportunity;
- any verified matching `APPROVED` transaction wins and activates once;
- never downgrade `succeeded` because of a delayed decline/error;
- after the retry window, a verified set of final non-approved transactions may mark the aggregate `failed`;
- if a verified approval arrives after `failed`, advance to `succeeded`, because Wompi has captured the User's money and Fidy must not leave them paid-but-inactive;
- local checkout-link expiry should be modeled separately from the three provider-driven BillingAttempt states rather than pretending Wompi declined it; the BillingAttempt can remain pending for later reconciliation until a verified provider outcome arrives.

This conclusion deliberately distinguishes immutable child transaction outcomes from the aggregate Fidy attempt outcome.

## Colombia IVA findings

### The general rule is not the whole answer

DIAN states that services supplied in Colombia are generally subject to IVA unless expressly excluded, and Article 468 supplies the general 19% rate absent an exception. [DIAN Oficio 902147 of 2022](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_902147_2022.htm)

However, Article 476's cloud-computing exclusion is potentially relevant. DIAN's unified cloud-computing doctrine says the exclusion applies only when the provider satisfies all required characteristics plus an accepted service and implementation model; merely calling a product “cloud” or licensing software in the cloud is insufficient. [DIAN Concepto 17056 of 2017](https://normograma.dian.gov.co/dian/compilacion/docs/concepto_tributario_dian_0017056_2017.htm)

DIAN's 2024 doctrine identifies SaaS as one cloud-computing service model and says the exclusion is available to the provider that actually supplies the qualifying cloud service. It also preserves the case-specific qualification requirement. [DIAN Oficio 1959 of 2024](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_1959_2024.htm)

DIAN further warns that bundled services must be classified separately; a cloud exclusion cannot simply be extended to related services the statute did not exclude. [DIAN Concepto 13328 of 2025](https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_13328_2025.htm)

**Conclusion:** Fidy may be a qualifying SaaS/cloud provider, a taxable software/financial-information service, or a bundle requiring allocation. The repository cannot determine that legal classification from architecture alone. “IVA included” is safe consumer-price language, but **hard-coding a 19% tax revision is not safe** until a Colombian tax adviser reviews Fidy's exact offering and entity facts.

### Consumer price and Wompi tax detail

The Colombian consumer authority says advertised prices must be total prices including applicable taxes and additional charges. [SIC: Public price information](https://sedeelectronica.sic.gov.co/temas/proteccion-al-consumidor/derechos-y-deberes/inconvenientes-precio)

Wompi accepts an optional VAT-in-cents detail inside the already inclusive total. It does not add the VAT amount to `amount_in_cents`; its example is COP 119,000 total = COP 100,000 base + COP 19,000 VAT. [Wompi: Widget & Checkout Web](https://docs.wompi.co/docs/colombia/widget-checkout-web/)

**Conclusion:** retain the advertised gross Money exactly. Only send Wompi's optional VAT detail after tax classification, invoice precision, and rounding are approved. Do not derive and persist a guessed 19% split.

## Renewal-anchor recommendation

The first paid period should begin at Wompi's verified provider `finalized_at` instant, not webhook receipt time, because webhook delivery can be delayed.

Recommended deterministic rules:

- **weekly:** add exactly seven calendar days from the anchor;
- **monthly:** preserve the original day-of-month; if a month lacks it, use that month's last day without forgetting the original day (January 31 → February 28/29 → March 31);
- **yearly:** preserve month/day; for February 29, use February's last day in non-leap years and return to February 29 in leap years;
- compute the calendar boundary in the captured Subscription zone (`America/Bogota` at launch), persist the resulting UTC instant, and charge automatically without a pre-renewal reminder;
- retries/dunning after a failed automatic charge remain #37's responsibility.

These are product recommendations, not Wompi requirements.

## Work that should be split out

1. **Merchant capability / recurring enrollment gate:** confirm the aggregator account, all three recurring methods, DaviPlata production activation, acceptance flow, and sandbox source creation before #36 implementation.
2. **Tax and invoicing classification:** obtain written professional determination of IVA treatment, Price tax identity, Wompi VAT detail, invoicing, precision, and refunds/credit notes.
3. **Refunds and billing corrections:** separate from #36, while #36 preserves enough immutable provider and charge history to support it.
4. **Scheduled plan changes:** an existing Pro User selects the next Price; current access/price/anchor remain untouched, no immediate charge occurs, and the change is applied at the next renewal by #37.

## Unresolved merchant/legal questions

- Does Fidy's Wompi aggregator contract actually enable payment sources for card, Nequi, and DaviPlata, and does it alter the documented flow?
- Is DaviPlata recurring enrollment activated for the production merchant?
- Does Wompi require or recommend retaining specific acceptance evidence beyond the payment-source record?
- Is Fidy's supplied service a qualifying cloud-computing/SaaS exclusion, a 19%-rated service, or a mixed supply?
- What electronic-invoice and credit-note duties apply to Fidy's legal entity and customer population?
