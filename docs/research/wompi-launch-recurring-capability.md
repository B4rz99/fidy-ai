# Wompi recurring capability gate for Fidy launch methods

Issue: [#223 — Confirm Wompi recurring capabilities for launch methods](https://github.com/B4rz99/fidy-ai/issues/223)  
Research date: 2026-08-13 UTC  
Status: **launch-blocking merchant validation remains incomplete**

## Question

Can Fidy's actual Wompi aggregator merchant create a reusable payment source for card, Nequi,
and DaviPlata, then make a distinct later merchant-initiated Subscription charge without asking
its User to enter payment details again?

## Executive answer

**Not yet proven for Fidy.** Wompi's current public Colombia guide documents the general flow for
all three methods: authorize/tokenize once, create an `AVAILABLE` payment source, and later create a
transaction with its `payment_source_id`. The later transaction is expressly described as requiring
no direct User intervention. [Wompi, “Fuentes de pago & Tokenización,” introduction and “Paso 3”](https://docs.wompi.co/docs/colombia/fuentes-de-pago/)

That provider-level capability is not merchant-level evidence. This worktree/session contains no
Fidy Wompi keys, no merchant-console export or screenshot, no Wompi support confirmation, and no
redacted Sandbox source/transaction receipts. The checked-in environment template has no Wompi
configuration (`.env.example:1-28`). Consequently:

- card recurring is **blocked** pending Fidy's processor/network and 3DS/3RI enablement confirmation;
- Nequi recurring is **blocked** pending account confirmation and an end-to-end Sandbox receipt;
- DaviPlata recurring is **blocked** pending explicit production recurring activation and a Sandbox
  receipt; and
- ordinary Wompi Web Checkout must not be substituted for any of those proofs. The documented
  recurring path is the payment-source API; the separate checkout guide does not say that checkout
  creates a reusable source. [Wompi, “Inicio rápido,” checkout versus API payments](https://docs.wompi.co/docs/colombia/inicio-rapido/)

**Conclusion:** do not close #223 or unblock #36. The unresolved items below are launch blockers, not
reasons to weaken automatic renewal into payer-initiated checkout.

## Acceptance-criteria disposition

| #223 criterion                                                  | Result                      | Evidence / missing evidence                                                                                                      |
| --------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Account confirms reusable card, Nequi, and DaviPlata sources    | **Blocked**                 | Public docs say the products exist; no Fidy merchant-console or written Wompi confirmation was available.                        |
| DaviPlata production activation recorded                        | **Blocked**                 | The recurring guide requires commercial-team activation; Fidy's status is unknown.                                               |
| Card processor/network constraints recorded                     | **Partially complete**      | Public constraints are recorded below; Fidy's processor and enabled franchises are unknown.                                      |
| Sandbox source plus distinct later charge for each method       | **Blocked**                 | No Fidy Sandbox credentials or redacted provider receipts were available.                                                        |
| Payer fields, acceptances, authorization, cancellation, secrets | **Partially complete**      | Public requirements are recorded; card/Nequi source cancellation and four documentation inconsistencies need Wompi confirmation. |
| Unknown capability reported as a blocker                        | **Complete in this report** | No one-time checkout fallback is treated as recurring proof.                                                                     |

## What Wompi publicly owns

### Shared payment-source lifecycle

Wompi describes this lifecycle:

1. collect/tokenize the payment method once;
2. create a payment source with `POST /v1/payment_sources`; and
3. create a later transaction with `POST /v1/transactions` and the source's id.

The source transaction uses the merchant private key from the backend. Wompi says an available
source id can charge periodically or on demand without direct User intervention. A card source adds
`payment_method.installments`; non-card source transactions omit `payment_method` in the guide's
example. [Wompi, “Fuentes de pago & Tokenización,” “Paso a paso,” “Paso 2,” and “Paso 3”](https://docs.wompi.co/docs/colombia/fuentes-de-pago/)

A new transaction is asynchronous and starts `PENDING`; Wompi instructs merchants to poll or use
webhooks until a final state rather than treating creation as payment success.
[Wompi, “Métodos de pago,” introduction and final statuses](https://docs.wompi.co/docs/colombia/metodos-de-pago/)

**Conclusion:** an `AVAILABLE` source and an `APPROVED` later transaction are separate proof points.
Neither source creation nor a synchronous API response proves a successful BillingAttempt.

### Required Wompi acceptances

For API-created transactions and payment sources that collect personal data, Wompi requires two
current pre-signed values:

- `acceptance_token` for the end-user policy; and
- `accept_personal_auth` for personal-data processing authorization.

The merchant fetches both and their contract `permalink` values from
`GET /merchants/:merchant_public_key`, displays both contracts, obtains explicit acceptance of each
in its own UI (Wompi suggests checkboxes), and then submits the tokens.
[Wompi, “Tokens de Aceptación,” steps 1–4](https://docs.wompi.co/docs/colombia/tokens-de-aceptacion/)

Creating a payment source additionally requires `customer_email`, `type`, and the method token. The
main payment-source guide shows both acceptance fields for card, Nequi, and DaviPlata source
creation. [Wompi, “Fuentes de pago & Tokenización,” “Paso 2”](https://docs.wompi.co/docs/colombia/fuentes-de-pago/)

**Conclusion:** Fidy needs an authenticated web enrollment UI. Chat is not an acceptable place to
collect card/account credentials, OTPs, or the two explicit contract acceptances.

### Card

#### Payer data and initial authorization

Wompi's card tokenization input consists of card number, CVC, expiry month/year, and cardholder
name. The current Spanish guide recommends fetching Wompi's tokenization public key, encrypting
those values as JWE with RSA-OAEP-256/A256GCM, and sending the result to
`POST /v1/tokens/cards` under the merchant public key. Wompi warns the merchant not to store
sensitive card data. [Wompi, “Métodos de pago,” “Tarjetas de Crédito o Débito” and “Tokeniza una tarjeta”](https://docs.wompi.co/docs/colombia/metodos-de-pago/#tarjetas-de-cr%C3%A9dito-o-d%C3%A9bito)

For an authenticated recurring credential, Wompi documents a 3DS payment-source flow that may
require browser-information, fingerprint, and issuer challenge rendering before the source reaches
`AVAILABLE`. `DECLINED` and `ERROR` are unusable terminal source states.
[Wompi, “Fuentes de pago con 3DS,” steps 1–5](https://docs.wompi.co/docs/colombia/fuentes-de-pago-3ds/)

#### Processor and network limits

The public documentation imposes all of these limits:

- ordinary card payments list Visa, Mastercard, and American Express with CVC;
  [Wompi, “Métodos de pago,” card section](https://docs.wompi.co/docs/colombia/metodos-de-pago/#tarjetas-de-cr%C3%A9dito-o-d%C3%A9bito)
- Credential on File (`recurrent`) is applied only when the card is Visa or Mastercard **and** the
  merchant's processor is RBM; a different franchise or processor silently runs without COF;
  [Wompi, “Fuentes de pago & Tokenización,” “Transacciones con COF”](https://docs.wompi.co/docs/colombia/fuentes-de-pago/#transacciones-con-cof)
- `recurrent: true` means authorized periodic charges of the same amount, while `false` means stored
  credential charges of different amounts without periodicity; omitting it runs without COF;
  [Wompi, “Fuentes de pago & Tokenización,” “Transacciones con COF”](https://docs.wompi.co/docs/colombia/fuentes-de-pago/#transacciones-con-cof)
- 3DS source enrollment is documented for Mastercard and Visa, but authenticated automatic 3RI
  transactions are documented only for Mastercard;
- 3DS availability can vary between Gateway and Aggregator merchants; and
- production 3DS on payment sources must be activated through Wompi's fraud-management/support
  channel. [Wompi, “Fuentes de pago con 3DS,” “Notas importantes”](https://docs.wompi.co/docs/colombia/fuentes-de-pago-3ds/#notas-importantes)

**Conclusions:**

1. American Express ordinary-payment support is not recurring-credential support. Exclude it from
   Fidy's recurring launch path unless Wompi confirms the exact credential behavior in writing.
2. Mastercard is the only network for which the public docs clearly join authenticated 3DS
   enrollment to later 3RI automatic charges.
3. Visa may have plain payment-source/COF behavior on RBM, but the public docs do not promise 3RI for
   it. Fidy must obtain account-specific wording before deciding whether Visa is launch-safe.
4. Fidy must ask how `recurrent` should be marked after an accepted PriceRevision changes the next
   periodic amount; the published `true`/`false` definitions do not cover “periodic, but amount
   changed.”

### Nequi

The public recurring flow asks for the Nequi-registered 10-digit phone number and creates a token
with `POST /v1/tokens/nequi` under the merchant public key. The User must approve the subscription
in Nequi; Fidy polls `GET /v1/tokens/nequi/:token` until it becomes `APPROVED`, then creates the
`NEQUI` payment source with payer email and both Wompi acceptances. The resulting source example is
`AVAILABLE`. [Wompi, “Fuentes de pago & Tokenización,” “Cuentas Nequi” and “Nequi” source creation](https://docs.wompi.co/docs/colombia/fuentes-de-pago/)

Wompi's support definition confirms the intended semantics: the payer authenticates on the first
interaction, authorizes future debits, and later payments occur automatically without the payer
entering to pay. [Wompi support, “¿Qué es pago recurrente?”](https://soporte.wompi.co/hc/es-419/articles/36481489643411--Qu%C3%A9-es-pago-recurrente)

The Sandbox data guide assigns `3991111111` to approved Nequi transactions and `3992222222` to
declined ones, but it does not separately explain how the Nequi **subscription-token approval** is
simulated. [Wompi, “Datos de prueba en Sandbox,” “Nequi”](https://docs.wompi.co/docs/colombia/datos-de-prueba-en-sandbox/#nequi)

**Conclusion:** the product path is documented, but Fidy still needs merchant enablement evidence
and an observed Sandbox token-approval/source/charge sequence. The missing token-approval
simulation detail should be resolved with Wompi rather than inferred from one-time transaction test
data.

### DaviPlata

The public recurring guide requires:

- merchant public key;
- payer document type and number;
- the DaviPlata product phone number;
- an OTP send followed by OTP validation through provider-returned URLs and one-use bearer tokens;
- an `APPROVED` DaviPlata token;
- payer email and both Wompi acceptance tokens; and
- backend source creation with `type: "DAVIPLATA"` and the merchant private key.

The resulting source must be `AVAILABLE` before charging. Production allows at most two OTP sends
and two OTP validations. Wompi also says a DaviPlata payer can tokenize only once per business, a
constraint that Sandbox cannot reproduce. [Wompi, “Fuentes de pago & Tokenización,” “Cuentas DaviPlata”](https://docs.wompi.co/docs/colombia/fuentes-de-pago/#cuentas-daviplata)

The Sandbox guide supplies recurring test product numbers (`3991111111` approved,
`3992222222` declined transaction, `3993333333` invalid wallet) and OTPs (`574829` approved,
`932016` existing-subscription decline). [Wompi, “Datos de prueba en Sandbox,” “DAVIPLATA — Pago recurrente”](https://docs.wompi.co/docs/colombia/datos-de-prueba-en-sandbox/#daviplata---pago-recurrente)

The recurring guide explicitly says DaviPlata must be activated by Wompi's commercial team before
production use. [Wompi, “Fuentes de pago & Tokenización,” “Cuentas DaviPlata”](https://docs.wompi.co/docs/colombia/fuentes-de-pago/#cuentas-daviplata)
A support article separately says DaviPlata as a payment method is included in Wompi's public plans
without additional setup. [Wompi support, “¿Cómo puedo incluir DaviPlata como medio de pago en mi comercio?”](https://soporte.wompi.co/hc/es-419/articles/36481570859539--C%C3%B3mo-puedo-incluir-Daviplata-como-medio-de-pago-en-mi-comercio)

**Resolution of apparent conflict:** the support article speaks generally about including DaviPlata
as a payment method; the API guide speaks specifically about recurring DaviPlata tokenization. The
more specific recurring activation requirement controls this launch gate. Ordinary DaviPlata being
visible at checkout is not proof that reusable DaviPlata sources are enabled.

## Cancellation and revocation

For DaviPlata, Wompi explicitly documents
`PUT /v1/payment_sources/{payment_source_id}/void` under the merchant private key. It changes the
source to `VOIDED`, prevents later source transactions, and unsubscribes the DaviPlata account from
the business. [Wompi, “Fuentes de pago & Tokenización,” DaviPlata recommendations](https://docs.wompi.co/docs/colombia/fuentes-de-pago/#recomendaciones-1)

The same guide also documents the endpoint for Bancolombia sources, but does not state that it is
valid for card or Nequi. The API reference linked by Wompi is version 1.2.0; it models only `CARD`
and `NEQUI` source creation and has no payment-source void operation, while the newer narrative
guide adds DaviPlata and voiding. [Wompi's linked OpenAPI 1.2.0](https://api.swaggerhub.com/apis/waybox/wompi/1.2.0)

**Conclusion:** provider revocation is confirmed only for DaviPlata among Fidy's three methods.
Fidy may always cancel its own Subscription and stop scheduling future BillingAttempts, but #223
must obtain the supported card and Nequi source-revocation operation and semantics before claiming
that stored provider authority is cancelled.

## Secret and data boundaries

Wompi has separate Sandbox and Production public keys, private keys, event secrets, and integrity
secrets; the environments and their data are independent. Public keys use `pub_test_`/`pub_prod_`,
private keys use `prv_test_`/`prv_prod_`, and event/integrity secrets have corresponding environment
prefixes. [Wompi, “Ambientes & Llaves”](https://docs.wompi.co/docs/colombia/ambientes-y-llaves/)

Apply these boundaries:

| Value                        | Boundary                                                                                                                                | Basis                                                                                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merchant public key          | Browser/app may use it for tokenization and merchant contract lookup                                                                    | Wompi assigns public keys to client-side tokenization and acceptance lookup. [Payment methods](https://docs.wompi.co/docs/colombia/metodos-de-pago/#tokeniza-una-tarjeta), [acceptances](https://docs.wompi.co/docs/colombia/tokens-de-aceptacion/) |
| Card/account details and OTP | Send directly to Wompi from the authenticated enrollment UI; never send through Fidy chat or retain                                     | Wompi warns against retaining sensitive payment-method data. [Payment sources](https://docs.wompi.co/docs/colombia/fuentes-de-pago/#paso-1-pide-la-informaci%C3%B3n-del-medio-de-pago)                                                              |
| Private key                  | Fidy server secret only                                                                                                                 | Source creation and source-based transactions require backend private-key use in the main guide. [Payment sources](https://docs.wompi.co/docs/colombia/fuentes-de-pago/#paso-2-crea-una-fuente-de-pago)                                             |
| Integrity secret             | Fidy server secret only                                                                                                                 | Wompi says to compute the transaction SHA-256 signature on the server, never the frontend. [Widget/Checkout, “Genera una firma de integridad”](https://docs.wompi.co/docs/colombia/widget-checkout-web/#paso-3-genera-una-firma-de-integridad)      |
| Event secret                 | Fidy server secret only                                                                                                                 | Wompi uses it to verify webhook checksums and says it differs from the private key. [Events, “Seguridad”](https://docs.wompi.co/docs/colombia/eventos/#seguridad)                                                                                   |
| Acceptance tokens            | Ephemeral provider inputs tied to the two contracts; do not treat as durable payment authority                                          | Wompi defines them as proof that the current contracts were presented and accepted. [Acceptance tokens](https://docs.wompi.co/docs/colombia/tokens-de-aceptacion/)                                                                                  |
| Payment-source id            | Persist server-side as a provider reference under normal User-scoped access controls; do not expose it through chat or public responses | Wompi requires both the source id and merchant private key for later automatic charges. [Payment sources, “Paso 3”](https://docs.wompi.co/docs/colombia/fuentes-de-pago/#paso-3-crea-una-transacci%C3%B3n)                                          |
| Safe source metadata         | Persist only an allowlisted projection needed for display/audit (method, source id/status, card brand/last four where returned)         | **Fidy conclusion** from Wompi's prohibition on sensitive-data storage; do not persist raw responses, full phone/document values, card tokens, or OTP service tokens.                                                                               |

## Public-documentation inconsistencies requiring provider confirmation

These are not safe to resolve by guessing:

1. **3DS source authentication:** the main source guide and linked OpenAPI say source creation and
   source lookup require the private key, but the 3DS Sandbox guide shows the public key for both
   `POST /payment_sources` and `GET /payment_sources/{id}`.
   [Main source guide](https://docs.wompi.co/docs/colombia/fuentes-de-pago/#paso-2-crea-una-fuente-de-pago),
   [3DS Sandbox steps 3 and 5](https://docs.wompi.co/docs/colombia/fuentes-de-pago-3ds-sandbox/#paso-3-crear-la-fuente-de-pago-con-3d-secure),
   [OpenAPI 1.2.0](https://api.swaggerhub.com/apis/waybox/wompi/1.2.0)
2. **Second acceptance in 3DS:** the acceptance guide says both acceptance values are mandatory for
   payment sources, while the 3DS guides' source bodies contain only `acceptance_token`.
   [Acceptance guide](https://docs.wompi.co/docs/colombia/tokens-de-aceptacion/),
   [3DS Sandbox source body](https://docs.wompi.co/docs/colombia/fuentes-de-pago-3ds-sandbox/#paso-3-crear-la-fuente-de-pago-con-3d-secure)
3. **Acceptances on later source charges:** the acceptance guide says API transactions require both
   values, but the payment-source guide's later merchant-initiated transaction omits both. Requiring
   a fresh explicit acceptance at every unattended renewal would conflict with the documented
   unattended-payment purpose, so Wompi must state the actual contract.
   [Acceptance guide](https://docs.wompi.co/docs/colombia/tokens-de-aceptacion/),
   [source transaction body](https://docs.wompi.co/docs/colombia/fuentes-de-pago/#paso-3-crea-una-transacci%C3%B3n)
4. **Source cancellation:** DaviPlata voiding is documented, but card/Nequi voiding is not; the
   linked OpenAPI omits the void operation entirely.
   [DaviPlata recommendations](https://docs.wompi.co/docs/colombia/fuentes-de-pago/#recomendaciones-1),
   [OpenAPI 1.2.0](https://api.swaggerhub.com/apis/waybox/wompi/1.2.0)

## Required Fidy Sandbox proof

Run this only with **Fidy's** Sandbox merchant, not sample documentation credentials. Keep secrets
out of the report and commit only redacted evidence.

### Shared setup

1. Record the redacted Sandbox merchant id, account model (`Negocios`/Aggregator), and enabled
   methods from the console or Wompi response.
2. Fetch the merchant's two current contract links/tokens; render two explicit unchecked
   acceptances and record the contract identities/hashes plus acceptance UTC instant, not raw JWTs.
3. Use a new synthetic payer and unique transaction reference for each method.
4. End the interactive enrollment session after the source becomes `AVAILABLE`.
5. From a distinct backend-only step, create a later transaction using only the stored source id and
   server-owned transaction facts. Do not send the original card/account/OTP data.
6. Poll or consume a verified Wompi event until the transaction is `APPROVED`.
7. Record a redacted receipt containing method, source id suffix, source `AVAILABLE` observation,
   later transaction id/reference suffix, `payment_source_id` linkage, amount/currency, created and
   finalized UTC timestamps, and final status. Wompi defines events and checksum verification in
   [“Eventos”](https://docs.wompi.co/docs/colombia/eventos/).

### Card case

- Use the documented 3DS challenge Sandbox card `2303 7799 5100 0446`, complete the challenge as
  approved, and require the source to reach `AVAILABLE`.
- Create the later backend transaction with `payment_source_id`, one installment, and the
  Wompi-confirmed `recurrent` value; require `APPROVED`.
- Record whether the response identifies Mastercard, whether 3DS/3RI is active for Fidy's
  Aggregator merchant, and which processor handled it.

The card and challenge behavior comes from Wompi's dedicated
[3DS Sandbox guide](https://docs.wompi.co/docs/colombia/fuentes-de-pago-3ds-sandbox/).

### Nequi case

- Use the Wompi-confirmed Sandbox simulation for Nequi subscription approval; do not assume the
  one-time transaction number alone proves token approval.
- Require the Nequi token to reach `APPROVED`, create an `AVAILABLE` source, close the payer flow,
  and create a distinct later backend transaction from its id.
- Require the later transaction to reach `APPROVED` without a new Nequi prompt.

The provider lifecycle is documented in
[“Fuentes de pago & Tokenización,” Nequi](https://docs.wompi.co/docs/colombia/fuentes-de-pago/#cuentas-nequi).

### DaviPlata case

- Use product number `3991111111` and OTP `574829` in Sandbox.
- Require OTP-authenticated token `APPROVED`, source `AVAILABLE`, and then an `APPROVED` distinct
  later transaction after the interactive flow is closed.
- Exercise `PUT /payment_sources/{id}/void`, require `VOIDED`, and prove one subsequent test charge
  is rejected without creating a Fidy BillingAttempt that could activate Pro.

The test values and source-void semantics are provider-owned in
[Sandbox test data](https://docs.wompi.co/docs/colombia/datos-de-prueba-en-sandbox/#daviplata---pago-recurrente)
and the [DaviPlata source recommendations](https://docs.wompi.co/docs/colombia/fuentes-de-pago/#recomendaciones-1).

## Exact written confirmations to obtain from Wompi

Ask Wompi support/commercial to identify Fidy's Sandbox and Production merchant ids in its reply and
answer all of these:

1. Is each merchant the `Negocios`/Aggregator model, and can it create and later charge
   `CARD`, `NEQUI`, and `DAVIPLATA` payment sources?
2. Is recurring DaviPlata tokenization activated in Production now? If not, what commercial,
   contractual, technical, or review step remains, who owns it, and what is its completion date?
3. Which card processor is assigned to Fidy? Is it RBM? Which networks support payment sources, COF,
   3DS enrollment, and merchant-initiated recurring transactions for this Aggregator account?
4. Is 3RI truly Mastercard-only? What authenticated recurring behavior is supported for Visa, and
   is American Express excluded from reusable recurring sources?
5. Which `recurrent` value must Fidy send for fixed periodic renewals, and which value applies when a
   future PriceRevision changes the amount at a period boundary?
6. For 3DS payment-source create/status calls, must the browser use the public key or must Fidy's
   backend use the private key? Is `accept_personal_auth` required in addition to
   `acceptance_token`?
7. Must a later unattended `payment_source_id` transaction send either acceptance token? If yes,
   which accepted contract evidence/token is valid after the pre-signed JWT expires?
8. What supported operation revokes card and Nequi sources, what final status results, and does it
   revoke provider authority rather than merely hide the source?
9. How does Fidy's Sandbox merchant simulate Nequi subscription approval?

Wompi distinguishes its Aggregator (`Modelo Negocios`) from Gateway by saying the former has Wompi's
direct relationship with each payment method and central settlement, while Gateway requires the
merchant's own Bancolombia agreements/codes. That general model description does not answer the
merchant-specific questions above. [Wompi support, “¿Qué diferencia el modelo Negocios del modelo Gateway?”](https://soporte.wompi.co/hc/es-419/articles/360020775954--Qu%C3%A9-diferencia-el-modelo-Negocios-del-modelo-Gateway)

## Launch gate

#223 may be resolved only when the repository or linked issue contains:

- written Wompi/console evidence for both Fidy environments;
- explicit Production DaviPlata recurring and card 3DS/processor status;
- one redacted end-to-end Sandbox receipt per launch method;
- resolved answers to the four documentation inconsistencies;
- a provider-revocation contract for all three methods; and
- no secret or raw payment credential in committed artifacts.

Until then, card, Nequi, and DaviPlata automatic renewal all remain **launch blockers**.
