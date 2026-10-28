# Bancolombia sandbox cleanup protocol research — #1268

Checked 2026-10-27. Scope: anonymous discovery, Bancolombia's public portal and its
downloadable contracts, OAuth standards, and searches for applicable Ozone documentation.
The public-source investigation did not read private bank files or send support messages.
A subsequent authorized credential check and controlled Basic-authentication probe are recorded below.

## Conclusion

Several questions previously bundled into a support request are already answerable.
The public portal's unavailable API view does **not** mean the contracts are unavailable:
the older sandbox portal still serves its public YAML and Markdown files when requested
with the same public portal header its own JavaScript uses. Account response examples and
pagination are available. Token revocation request mechanics come from OAuth standards,
and Bancolombia publishes the endpoint. Controlled live verification now establishes the
registered JWT/mTLS path for application-token introspection and revocation. Remaining gaps are
customer access/refresh-grant cleanup and isolation, and cancellation of a bank consent when the
exchange outcome is unknown and no token was received. The latter procedure is not established by
the examined contracts or read-only capability responses.

The support-supplied Postman collection and subsequent support correction remain the
selected profile. Conflicting public examples must not override the corrected consent
creation body or the Postman consent URL.

## Recovered public bank material

The [sandbox portal](https://developer-portal-public-sbx.apps.ambientesbc.com/) loads
`main.f01727443cad5225.js`. Its public API client uses a `client-id` header for downloading
Open Banking descriptions; that header is portal infrastructure, not Fidy's bank client
credential. An anonymous download without that header returned HTTP 400; using the
portal's own header returned HTTP 200 for the files below. No login token was needed.

| Source                                                                                                                                                                               |  Bytes | SHA-256                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -----: | ------------------------------------------------------------------ |
| [Account consent YAML](https://apic-ext-sbx.apps.ambientesbc.com/developer-portal-public/apis/open-banking/account-information/account-information-account-access-consents.yaml)     | 28,571 | `7f6bdf7d362f858dc4ef0e7127965f1529847c7cfeaa201462df564bbba94d6f` |
| [Accounts YAML](https://apic-ext-sbx.apps.ambientesbc.com/developer-portal-public/apis/open-banking/account-information/account-information-accounts.yaml)                           | 18,495 | `ed4cd62bf7c24b7f64161f53c059b1456bed75eb41edf22b6768126dd9305ff7` |
| [Authorization guide](https://apic-ext-sbx.apps.ambientesbc.com/developer-portal-public/products/open-banking/open-banking-authorization/openBanking-Authorization-Documentation.md) |  8,923 | `aef3fcf108a8ddb1382fd72f4650a1f637871114f88e16195a7817a22ff82d0f` |
| [Account information guide](https://apic-ext-sbx.apps.ambientesbc.com/developer-portal-public/products/open-banking/account-information/accounts-information-Documentation.md)       | 12,172 | `c80375ddd3f6c86f9c287fc5fefc4272ff5fbee4c97335cf1da74748dfeb5b0e` |
| [Token management YAML](https://apic-ext-sbx.apps.ambientesbc.com/developer-portal-public/apis/open-banking/open-banking-authorization/access-token-management.yaml)                 | 13,802 | `ce962bf47aa5d4804b940908ac2f5a3dbe231eca8b08def7831f0bbc1c382139` |

The [public product list](https://apic-ext-sbx.apps.ambientesbc.com/developer-portal-public/products/open-banking/productListOB.json)
identifies these contract filenames. These are the same consent/accounts/guide bytes
previously recorded in the repository's August research; retrieval now confirms continued
public availability, not that every example matches Fidy's October support profile.

## What the bank already publishes

1. [Live OIDC discovery](https://auth1-api-open-finance-sandbox.ambientesbc.com/.well-known/openid-configuration)
   publishes revocation at
   `https://as1-api-open-finance-sandbox.ambientesbc.com/token/revoke` and introspection at
   `https://as1-api-open-finance-sandbox.ambientesbc.com/introspection`. Their mTLS aliases
   are those same URLs. Token endpoint methods include `client_secret_basic`,
   `client_secret_jwt`, `tls_client_auth`, and `private_key_jwt`. Discovery contains no
   revocation-specific or introspection-specific authentication method metadata.
2. The [accounts contract](https://apic-ext-sbx.apps.ambientesbc.com/developer-portal-public/apis/open-banking/account-information/account-information-accounts.yaml)
   contains `Data.AccountReport[]`, including `AccountIdentification`, and **nested
   `Data.Links`**. `Previous`, `Self`, `Next`, and `Last` use `pageNumber` in examples.
   Absence of `Next` means the last page. Its example host/path is illustrative; it must
   not be blindly followed with a bearer token. It does not define `Meta.TotalPages`.
3. The [consent contract](https://apic-ext-sbx.apps.ambientesbc.com/developer-portal-public/apis/open-banking/account-information/account-information-account-access-consents.yaml)
   defines POST creation and GET retrieval, with sample response fields including
   `ConsentId`, `Permissions`, `Status`, and `StatusUpdateDateTime`. It defines **no DELETE,
   PATCH, or other consent cancellation operation**. Its GET path is
   `/accounts/{consentId}/account-access-consent`, which conflicts with the support
   collection's selected path; the public path does not override support.
4. The [account information guide](https://apic-ext-sbx.apps.ambientesbc.com/developer-portal-public/products/open-banking/account-information/accounts-information-Documentation.md)
   describes revoked consent through the ASPSP interface and business error
   `BP40353007` for revocation. It does not specify a TPP cancellation request. Its status
   table uses Spanish labels, not a definitive wire-value enum. Its token guidance assigns
   client credentials to consent access and authorization-code tokens to account data.
5. The [token management contract](https://apic-ext-sbx.apps.ambientesbc.com/developer-portal-public/apis/open-banking/open-banking-authorization/access-token-management.yaml)
   describes `/token` and a health operation only. Its `private_key_jwt` requirement is
   documented for token issuance; it supplies no revocation/introspection operation or
   uncertain-exchange reconciliation endpoint.

An actionable implementation correction follows from item 2: the current activation
response reader's top-level `Links` and `page` assumption does not match the recovered
public account response. Support's collection supplies no conflicting pagination example,
so this evidence should inform the reader and tests before live proof.

## What standards answer, and what they do not

| Question                                         | Answer available now                                                                                                                                                                                            | Boundary                                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Revocation method/body                           | HTTPS POST, form-encoded `token`, optional `token_type_hint=access_token` or `refresh_token`, client authentication. [RFC 7009 §2.1](https://www.rfc-editor.org/rfc/rfc7009.html#section-2.1)                   | Requires the actual token. There is no standard `ConsentId` parameter.                                                                   |
| Missing revocation auth metadata                 | RFC 8414 defaults to `client_secret_basic`; it does **not** inherit the token endpoint's method list. [RFC 8414 §2](https://www.rfc-editor.org/rfc/rfc8414.html#section-2)                                      | A standard-derived candidate for this bank profile; not proof Fidy's registration accepts it.                                            |
| Missing introspection auth metadata              | Authentication methods must be determined by other means. [RFC 8414 §2](https://www.rfc-editor.org/rfc/rfc8414.html#section-2)                                                                                  | Discovery alone does not prove `private_key_jwt` or Basic works here.                                                                    |
| Introspection body and result                    | Form POST with `token` and optional hint; response includes `active`. Authentication is mandatory. [RFC 7662 §2](https://www.rfc-editor.org/rfc/rfc7662.html#section-2)                                         | `active:false` can also mean the caller cannot inspect that token. Establish a positive baseline before using it as revocation evidence. |
| Does HTTP 200 prove bank cleanup?                | Revocation returns 200 even for an invalid token; related-token invalidation depends on supported policy. [RFC 7009 §2.2](https://www.rfc-editor.org/rfc/rfc7009.html#section-2.2)                              | Record actual evidence for every held token; a 200 response is not proof that a consent was canceled.                                    |
| Can a timed-out code exchange simply be retried? | A client must not use a code more than once; repeated use must be denied and should revoke previously issued tokens when possible. [RFC 6749 §4.1.2](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1.2) | Replaying a possibly consumed code is not a specified reconciliation procedure.                                                          |

OAuth token revocation and account consent cancellation are separate concepts. None of
these RFCs defines a bank-specific consent deletion route or guarantees that revoking a
token changes the bank's consent resource. No applicable public Bancolombia/Ozone source
establishing that missing operation was found in the sources searched. Ozone documentation
for another country's bank-internal consent manager is not evidence of a Bancolombia TPP
endpoint.

## Next verification and any eventual support question

The account response/pagination interpretation has been corrected using the recovered contract;
the support-defined request paths and corrected consent creation body remain authoritative. The
protected application-token lifecycle verification passed as recorded below. Customer grant cleanup
and isolation still require their own implementation and controlled verification.

The remaining bank-specific question is: **How does
Fidy invalidate or reconcile a particular account ConsentId when authorization-code
exchange may have succeeded but Fidy received no tokens?** Include the tested token
revocation/introspection results rather than asking the bank to repeat the already public
endpoints, generic request body, or account examples. Absence from the examined contracts
is evidence of a documentation gap, not proof that no bank-supported mechanism exists.

## Controlled Basic-authentication probe

On 2026-10-27, a separate authorized check confirmed the supplied environment's Basic credential
belongs to Fidy's registered client without printing it. Using that credential and the supplied
mTLS certificate, one client-credentials request to `/token` returned HTTP 400 `invalid_client`.
Because no token was issued, the subsequent `/introspection` and `/token/revoke` requests used an
explicitly invalid probe token. Both returned HTTP 400 `invalid_client`. There were no retries,
redirects, customer consent changes or Account reads. No raw credentials or response bodies were
recorded. This rules out treating the default Basic-authentication assumption as verified for Fidy;
it does not prove that the registered JWT method works at these endpoints.

The follow-up implementation routes a JWT application-token lifecycle check through the existing
protected Core verification. It must establish a positive active-token baseline before accepting
an inactive result after revocation. Customer access/refresh cleanup and uncertain-exchange
ConsentId handling remain unverified and are not installed as automatic cleanup on application-token
evidence alone.

## Live JWT application-token verification

PR [#1575](https://github.com/B4rz99/fidy-ai/pull/1575) passed all CI checks and merged as
`127ad191f29b288260876b63d3d4ada20866d8e1`. The normal [protected release](https://github.com/B4rz99/fidy-ai/actions/runs/40604041447)
completed successfully. The [signed live verification](https://github.com/B4rz99/fidy-ai/actions/runs/40604618334)
ran with `verify_bancolombia_sandbox=true` and passed on 2026-10-27. Inside Core, the registered
RS256/private_key_jwt key and mTLS binding issued an accounts application token, obtained active
introspection, revoked that token once, and obtained inactive introspection before natural expiry.
No token or signing key was exported. Sandbox customer admission remained disabled and production
institution registration stayed empty.

This establishes the selected JWT/mTLS authentication and active-to-inactive application-token
behavior for the advertised endpoints. It does not establish refresh-token handling, customer-grant
isolation, customer-token cleanup or account-consent cancellation by ConsentId.

## Read-only consent capability observation

On 2026-10-27, mTLS `OPTIONS` requests to the support-selected consent collection and an explicitly
invalid individual consent-resource path returned HTTP 200. The collection advertised `Allow: POST`;
the individual resource advertised `Allow: GET, HEAD`. Neither advertised DELETE/cancellation.
No customer consent was read or changed. Local system DNS failed to resolve the supplied resource
host, while public Cloudflare DNS returned a successful answer. The check used that public
resolution while preserving the bank hostname and normal TLS certificate verification; it did not
disable TLS checks, follow redirects or retry.

Together with the reviewed contracts, this leaves a specific documentation/verification gap:
which bank-supported operation cancels or reconciles an account ConsentId when an authorization-code
exchange might have succeeded but no tokens were received. These observations do not prove that no
separate cancellation endpoint exists; that procedure still needs bank confirmation.

## Held-token implementation follow-up

The follow-up now implements held customer-token cleanup through the protected bank adapter and
private scheduled recovery. It persists positive token-inspection baselines under the exact grant
lease before revocation, attempts both held token kinds independently, and requires inactive results
before destroying the encrypted envelope. A validated original access-token expiry can establish
that an already-expired access token is unusable; an unverified inactive refresh token cannot.
Failure, interruption, concurrent recovery, foreign keys, different Users, replacement generations,
and a response missing signed identity are covered at the public/Core/native-D1 seam. Retention
failure also attempts immediate cleanup without claiming a successful durable outcome.

This local implementation and substituted-transport evidence do not establish live customer-token
behavior or bank-side isolation between separate customer grants. Those still require controlled
sandbox verification. ConsentId cancellation after an uncertain exchange with no held tokens remains
the focused bank-support question above; no new public cancellation contract was discovered.
