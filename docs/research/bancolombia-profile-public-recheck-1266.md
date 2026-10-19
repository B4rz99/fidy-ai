# Bancolombia public profile recheck — #1266

Assessment date: **2026-10-19**. Scope: public Account Information authorization,
provisioning, and data semantics. No client credential was used, no authorization flow
was initiated, and no bank customer data or test API was requested. This note does not
establish bank acceptance, production eligibility, or a functioning integration.

## Current public evidence

The public support articles were readable on this assessment date. Their displayed
update dates are listed below; they are not evidence of a deployment version or a
client-specific agreement.

| Source                                                                                                                                                                  | Displayed update | What it establishes                                                                                                                                                                                                                         | What it does not establish                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Authorization URL / PAR utility](https://soportedevs.bancolombia.com/hc/es-419/articles/52174225347220-Utilidad-GET-par-auth-code-url)                                 | 2026-08-05       | Authorization code flow; discover `authorization_endpoint` through OIDC; use the registered application's `client_id` and the `request_uri` returned by PAR. `accounts` appears as an example scope.                                        | Exact sandbox/production discovery or PAR endpoint, Fidy's granted scope, PAR authentication, lifetime, or registration acceptance. The example consent hostname is not an accepted per-environment endpoint inventory. |
| [Private-key JWT utility](https://soportedevs.bancolombia.com/hc/es-419/articles/52176354947604-Utilidad-Prepare-private-key-JWT)                                       | 2026-08-05       | RS256; `kid` matches a previously registered public JWKS key; private signing key matches that public key. `aud` comes from discovery `issuer`; `iss` and `sub` are the assigned `client_id`; `exp`, `iat`, and unique `jti` are described. | Maximum assertion lifetime, clock tolerance, key-rotation overlap, token endpoint authentication settings, or bank acceptance of Fidy's key.                                                                            |
| [PKCE guide](https://soportedevs.bancolombia.com/hc/es-419/articles/52176726751892--Qu%C3%A9-es-PKCE)                                                                   | 2026-08-05       | Random secret `code_verifier`, SHA-256/Base64URL challenge, `code_challenge_method=S256` in PAR, and original verifier at code exchange.                                                                                                    | An exact FAPI version, conformance certification, Fidy-specific metadata, or successful deployed enforcement. The article's mention of FAPI does not identify the full applicable bank profile.                         |
| [JWKS guide](https://soportedevs.bancolombia.com/hc/es-419/articles/29377200410516--Que-es-JWKS)                                                                        | 2024-08-13       | Public JWK-set representation and key metadata, including `kid`, `alg`, `use`, and certificate-chain metadata.                                                                                                                              | Accepted mTLS certificate authority, transport certificate policy, or equivalence between a signing key and a TLS client certificate.                                                                                   |
| [Production onboarding](https://soportedevs.bancolombia.com/hc/es-419/articles/22036835683860--C%C3%B3mo-solicitar-el-paso-a-producci%C3%B3n-con-los-productos-de-APIs) | 2025-05-05       | Sandbox access and testing precede commercial negotiation and production credentials sent to the technical representative. It describes an active Bancolombia savings/current account as a production prerequisite.                         | Account Information-specific participant approval, accepted terms for FIDY S.A.S., prices, scope grants, or sandbox success. Its generic prerequisite wording does not replace a product-specific eligibility decision. |

Three additional official pages—[first steps](https://soportedevs.bancolombia.com/hc/es-419/articles/29354511872020-Primeros-pasos-con-los-productos-API-de-Open-Banking),
[Postman setup](https://soportedevs.bancolombia.com/hc/es-419/articles/29387701324948--C%C3%B3mo-configuro-en-Postman-los-recursos-de-Open-Banking-para-probar-en-sandbox),
and [sandbox consumption](https://soportedevs.bancolombia.com/hc/es-419/articles/29470398359700--C%C3%B3mo-se-realiza-el-consumo-de-los-casos-de-uso-de-Open-Banking-en-sandbox)—were
readable, but their extracted bodies refer to embedded video tutorials. The video
contents were not inspected. These pages therefore supplied no independently verified
additional protocol parameters in this recheck.

The PAR article's concrete example authorization address is
`https://open-banking-consent.apps.bancolombia.com/auth`. It says to obtain the actual
address from discovery's `authorization_endpoint`. The article does not supply an exact
discovery URL, PAR endpoint URL, or token endpoint URL. Thus the example `/auth` path is
available public evidence, while Fidy's applicable environment endpoints remain unverified.

## Current retrieval limits

The following official static files returned **HTTP 400** on 2026-10-19 using ordinary
public HTTPS requests, including public-portal Origin and Referer headers. The web
reader also could not retrieve the authorization Markdown. No credentials, alternate
authenticated endpoint, or client-certificate bypass was attempted.

- [Authorization documentation](https://apic-ext-sbx.apps.ambientesbc.com/developer-portal-public/products/open-banking/open-banking-authorization/openBanking-Authorization-Documentation.md)
- [Account Information documentation](https://apic-ext-sbx.apps.ambientesbc.com/developer-portal-public/products/open-banking/account-information/accounts-information-Documentation.md)
- [Account Access Consents OAS](https://apic-ext-sbx.apps.ambientesbc.com/developer-portal-public/apis/open-banking/account-information/account-information-account-access-consents.yaml)
- [Accounts OAS](https://apic-ext-sbx.apps.ambientesbc.com/developer-portal-public/apis/open-banking/account-information/account-information-accounts.yaml)
- [Balances OAS](https://apic-ext-sbx.apps.ambientesbc.com/developer-portal-public/apis/open-banking/account-information/account-information-balances.yaml)
- [Transactions OAS](https://apic-ext-sbx.apps.ambientesbc.com/developer-portal-public/apis/open-banking/account-information/account-information-transactions.yaml)

This is a retrieval limitation, not evidence that the product is unavailable or that
the historic contract has been withdrawn. The [2026-08-22 baseline](davivienda-api-237.md#14-bancolombia-baseline)
records direct retrieval, exact source links, file sizes, hashes, and line citations.
It remains historical evidence; its files were not freshly retrieved in this session.

## Historical Account Information baseline requiring confirmation

Each row below cites the earlier research's identifiable official artifacts. None is a
newly observed October API response.

| Area                        | Previously retrieved bank documentation                                                                                                                                                                                                                                                               | Confirmation needed                                                                                                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport and authorization | Authorization prose describes `private_key_jwt`, mTLS, consent intent, PAR, authorization code, refresh tokens, and mTLS product requests. [B-AUTH lines 18–63](davivienda-api-237.md#consent-and-authorization)                                                                                      | Accepted authentication method at each endpoint; whether access/refresh tokens are certificate-bound; mTLS endpoint aliases; permitted CA/chain, subject/SAN, key usage, renewal, revocation and environment separation.          |
| Consent                     | ConsentId, permissions, history interval, expiry; durations 3 months/6 months/1 year, default 1 year; statuses Authorized, Rejected, Revoked, Expired and Awaiting authorization. [B-AI lines 19–39, 78–157](davivienda-api-237.md#consent-and-authorization)                                         | Exact status spellings on wire, state transitions, selected-account behavior, revocation operation/notifications, expiry and refresh-token interaction. Consent acceptance as a whole does not prove independent account toggles. |
| Account coverage            | Savings/current deposit accounts; natural/legal persons; AccountIdentification, AccountReference, AccountStatus, AccountType. [B-PORTAL / B-ACCOUNTS lines 427–472](davivienda-api-237.md#product-and-account-information-scope)                                                                      | Identifier stability across reconnects; supported account types and ownership/selection rules. Cards, loans and wallets are not established by this deposit-account product baseline.                                             |
| Balances                    | AVLB / TPBL balance categories. [B-BALANCES lines 835–863](davivienda-api-237.md#account-balance-and-transaction-semantics)                                                                                                                                                                           | Actual response shape, as-of/freshness meaning, currency coverage, and distinction from pending/credit-limit/liability amounts.                                                                                                   |
| Movements                   | Unique TransactionIdentification description, booking/value dates, DBIT/CRDT; STLD settled/completed, RJTD rejected, CAND cancelled, FNLD final processing potentially unsettled. [B-TRANSACTIONS lines 660–744, 763–807, 1099–1134](davivienda-api-237.md#account-balance-and-transaction-semantics) | Stability over repeated reads/pages/reauthorization, reversals and corrections, definitive completed status. FNLD must not be assumed completed.                                                                                  |
| Pagination                  | `pageNumber`, up to 40 movements per page, Previous/Self/Next/Last links. [B-TRANSACTIONS lines 82–110](davivienda-api-237.md#account-balance-and-transaction-semantics)                                                                                                                              | Ordering, terminal-page behavior, empty pages, link authority, traversal consistency under concurrent new movements, duplicates/omissions.                                                                                        |
| Rates and freshness         | `150/1second` is a response-header example; no normative production quota, polling rule, webhook/delta contract or freshness SLA was found in that earlier review. [B-TRANSACTIONS lines 1192–1221](davivienda-api-237.md#history-freshness-and-commercial-baseline)                                  | Contractual rate and scope, retry/Retry-After, sandbox/production differences, polling permission, history coverage and timestamps. An example is not a permitted request rate.                                                   |

### Unresolved source conflicts

The [historical conflict register](davivienda-api-237.md#17-conflicting-evidence) identifies
four bank-specific discrepancies that remain unresolved in current retrievable evidence:

1. Authorization prose uses authorization code for product resources; Accounts, Balances,
   and Transactions OAS security declarations name a client-credentials flow. Do not
   infer that application credentials alone authorize access to customer Accounts.
2. History prose describes 90 days when the start is omitted, an error table describes
   a three-month maximum, and Transactions YAML describes a four-month query range.
   These may refer to different boundaries, but the sources do not resolve that here.
3. The AccountType dictionary uses `CAAC`; a response example uses `CACC`.
4. `MultilateralBalance` is declared as an array with `properties` and no `items` in the
   earlier Balances OAS. Actual wire shape needs confirmation before code generation.

## Generic standards versus the bank's accepted profile

[RFC 8705 §§2–3](https://www.rfc-editor.org/rfc/rfc8705.html) distinguishes TLS client
authentication from certificate-bound tokens. They can be deployed separately. It
defines PKI and self-signed variants; that does **not** establish that Bancolombia accepts
either variant for Fidy. Publishing JWKS or serving HTTPS does not prove mTLS acceptance.

[RFC 9126](https://www.rfc-editor.org/rfc/rfc9126.html) defines PAR. It explains the
mechanism; the bank's accepted metadata and client registration must still determine
the actual endpoint, authentication and policy. Neither these RFCs nor a public tutorial
prove FAPI certification or production acceptance.

## Evidence needed to finish #1266

Public documentation is sufficient to prepare a profile worksheet and protocol test
plan. The remaining proof must identify the bank-approved client and environment:

1. Assigned client registration, subscribed product/version, grants and scopes; accepted
   redirect URI and JWKS registration, with signing-key rotation policy.
2. Issuer/discovery, authorization/PAR/token/resource endpoints and mTLS aliases,
   assertion policy, certificate requirements and certificate registration acceptance.
3. Current downloadable OAS/profile or written reconciliation of the conflicts above.
4. Bank-approved synthetic test identity, consent scenarios, Account coverage and rate
   allowance; then a bounded sandbox run of consent, code exchange, refresh,
   revocation, repeated movement identity and complete page traversal.
5. Separate production provisioning/eligibility and applicable contractual evidence.

These are missing acceptance/deployment artifacts, not additional public RFC research.
No public search can reveal whether a private client registration has been approved.
Successful sandbox behavior also cannot substitute for production provisioning. Keep
Bancolombia outside SupportedInstitution until its repository gate is satisfied.
