# Bancolombia sandbox handoff — #1266

Inspected 2026-10-27 against source revision `c5def45fd` and the two bank-supplied local files
below. The owner reports sandbox access and delivery of credentials and a transport certificate/key;
production access is unavailable because the bank's production environment is not ready. That report
supersedes the pending-access observations from 2026-10-19. It does not establish successful
credential installation, certificate registration, private-key possession or a bank round trip.

## Sources and handling

The inputs remain outside Git. Their hashes identify the exact inspected versions, not their
applicability to an accepted client or the absence of credentials.

| Local input                                        | SHA-256                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| `TPPs Open Banking Update.postman_collection.json` | `869a3da43fed9043b734e9be698e49234738cb3b1a26ca79cde3f606eb3fcd62` |
| `Fidyapp - CLIENT.json`                            | `0cfdb387b9fdce685c3489f90f3ad5bc2bb797fd3c471d8b885f6bf75f8e7dee` |

`CLIENT.json` has empty `_clientId` and `_clientSecret`, but also populated `basicToken` and
`oidcClient`. Treat the entire input as restricted: `basicToken` is decodable Basic-credential
material, not encryption, and its ownership/purpose has not been established. Do not commit the
original files, print these values, import them into a synced workspace or reuse the sample utility
authority in Fidy. No private-key PEM block or JWT-shaped bearer was found in the collection; that
limited scan is not a complete assurance that every supplied value is public.

The bank's instructions identify `pem-local` as the signing private key corresponding to Fidy's
JWKS and `kid-local` as its public key id. `certificado.pem` and `Llave.key` are separate transport
material. Neither file was supplied or opened during this assessment.

## Environment coordinates supplied in the template

| Purpose                             | Template value                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| Issuer                              | `https://auth1-api-open-finance-sandbox.ambientesbc.com`                                  |
| Discovery                           | `https://auth1-api-open-finance-sandbox.ambientesbc.com/.well-known/openid-configuration` |
| Token                               | `https://as1-api-open-finance-sandbox.ambientesbc.com/token`                              |
| Authorization                       | `https://auth1-api-open-finance-sandbox.ambientesbc.com/auth`                             |
| Account Information resource origin | `https://rs1-api-open-finance-sandbox.ambientesbc.com`                                    |
| Fidy redirect                       | `https://api.fidyapp.com/connections/bancolombia/sandbox/callback`                        |

The accompanying email instead names `as1-api-open-finance.bancolombia.com` and
`rs1-api-open-finance.bancolombia.com`. Do not combine these host families or send credentials to an
inferred alias. The template is a concrete sandbox candidate; exact client-applicable origins and
certificate coverage still require reconciliation. The web reader was inaccessible, but a subsequent
anonymous, no-redirect HTTPS GET of the discovery URL succeeded with HTTP 200 within a 64 KiB
read bound. No Basic credential or client certificate was sent. All three template hosts resolved
and completed server-verified TLS 1.2 handshakes; these are server-authentication observations,
not successful client-certificate authentication.

Discovery returned the exact template issuer, authorization and token URLs, PAR at
`https://as1-api-open-finance-sandbox.ambientesbc.com/par`, `S256`, and
`private_key_jwt` among the supported client authentication methods. Its advertised signing
algorithms include both `RS256` and `PS256`; this supports preserving Fidy's existing RS256
registration pending the credentialed test, rather than changing the JWKS to match a sample.
The server also advertises other methods/algorithms; Fidy must not accept `none` or HMAC merely
because discovery lists them. `tls_client_certificate_bound_access_tokens` is true. The mTLS
endpoint aliases use the same token/PAR origin and include `/token/revoke`, `/introspection`
and `/userinfo`; their presence alone does not establish the accepted revocation/refresh lifecycle.

Source: [sandbox discovery](https://auth1-api-open-finance-sandbox.ambientesbc.com/.well-known/openid-configuration),
observed 2026-10-27. The response is deployment metadata, not a guarantee of the exact methods
enabled for Fidy's assigned client.

## Account Information sequence observed in the collection

Only the `AIS` folder informs this slice. The `PIS` examples do not authorize payment development.

1. Discover authorization, token and pushed-authorization-request endpoints. The sample assigns
   `token-endpoint` while later requests use `tokenEndpoint`; validate discovery and use one
   authoritative value rather than copying both variable spellings.
2. Obtain an application token with `grant_type=client_credentials`, scope `accounts` and a
   private-key JWT assertion. This application token creates/reads consents; it is not the User's
   account-data authority.
3. Create `POST /open-banking/v1/deposits/accounts/account-access-consent` with five example
   permissions: `ReadAccountBasic`, `ReadAccountDetail`, `ReadBalance`, `ReadTransactionBasic` and
   `ReadTransactionDetail`. The sample includes historical dates, AccountOwner and OnBehalfOf values.
   Those are examples, not verified Fidy or authorized test-person facts; requiredness, valid history
   windows and the assigned `obParticipantId` are not resolved by the collection.
4. Use the returned `Data.ConsentId` in PAR scope `accounts:<ConsentId> openid`, together with the
   client id, exact redirect, state, response type `code`, S256 challenge and private-key JWT.
   The sample expects HTTP 201 and a `request_uri`. It does not establish expiry/replay semantics.
5. The sample calls an Ozone `par-auth-code-url` utility and manually opens its result. This is
   test tooling, not a validated Fidy browser handoff contract. The accepted authorization endpoint
   and request reference must be bound to the same ConnectionAttempt.
6. Exchange the returned authorization code using the original verifier and redirect, scope
   `accounts` and private-key JWT. A hardcoded example code is not usable authorization.
7. Use the User-authorized token for Accounts, Balances and Transactions beneath
   `/open-banking/v1/deposits/accounts`. The sample reads account identity from
   `Data.AccountReport[0].AccountIdentification`; it does not prove stability, complete schemas,
   movement status/identity, pagination, error handling or refresh/revocation behavior.

No collection scripts or credentialed requests were executed. Only public discovery and server TLS
were observed. No bank session, consent, token or financial data was created, read or retained.

## Differences and credentialed validation requirements

| Observation                                                                                                 | Required disposition                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The assertion sample specifies `PS256`; the existing public JWKS declares `RS256`.                          | Public discovery advertises both. Preserve the registered RS256 key and `kid` for the first protected client-authentication test; do not silently change the JWKS. Successful authentication must establish client-specific acceptance.                                                    |
| The signing utility sends `signingKeyPEM` to `/o3/v1.0/message-signature`.                                  | Do not reproduce this utility in Fidy or run it with Fidy's key. Sign inside private Core through the protected secret boundary.                                                                                                                                                           |
| The sample logs the PKCE verifier and derived challenge.                                                    | Do not execute the collection's scripts with real secrets. Generate and retain one private verifier per attempt; omit it from telemetry and artifacts.                                                                                                                                     |
| Basic authorization appears on discovery and utility calls; the template contains populated Basic material. | Determine its intended purpose privately. Do not forward it to discovered URLs or treat it as Fidy's client secret.                                                                                                                                                                        |
| The supplied email hosts and environment hosts differ.                                                      | Public discovery agrees with the template issuer/token/PAR origins. Use that sandbox candidate, validate discovered destinations, and verify the supplied certificate against the client-applicable endpoints; do not send credentials to the email aliases without separate confirmation. |
| The template leaves `obParticipantId` blank; consent examples contain person/company fields.                | Obtain the assigned non-secret participant identifier and approved synthetic test identity/scenario, plus the mandatory consent fields. Do not invent or copy the sample identities.                                                                                                       |

## Implementation boundary

The existing native Connections owner already provides same-User fresh-session continuation,
Origin/input admission, atomic single-use preparation, Consent/session rechecks and bounded attempt
retention. Reuse that state rather than adding a parallel attempt store. It currently stops at
`prepared`; it does not sign, create a bank consent, submit PAR, exchange codes or discover Accounts.
The sandbox callback remains deliberately unavailable. Current institution registration contains no
supported institution, and the production institution gate must remain disabled.

The next executable #1267 slice must connect the accepted profile to this existing continuation:
private Core signing; fixed-destination bounded outbound HTTP with certificate binding; durable
claim/settle around external calls; attempt-bound verifier/state/intent/PAR; and the validated bank
handoff. #1268 owns callback and activation. Synthetic protocol tests cannot establish bank acceptance.
The [transport research](../research/bancolombia-sandbox-mtls-1266.md) records the Cloudflare
installation boundary separately from the unresolved bank-specific configuration.

Before credentialed testing, the sole operator must place the client credentials, matching signing
key and transport certificate/key in their intended protected stores. Values must not pass through
chat, source, shell arguments or logs. File paths or protected binding names suffice for coordination;
never extract the existing GitHub signing secret or regenerate the registered key to bypass a missing
local copy. Successful sandbox testing remains separate from bank production eligibility.
