# Bancolombia authorization preparation — #1267

Updated 2026-10-27. [#1267](https://github.com/B4rz99/fidy-ai/issues/1267) requires a complete
validated bank handoff; this note identifies reusable preparation already present, not completion
of the bank flow. The [#1266 profile worksheet](bancolombia-profile-1266.md) owns unresolved accepted
client/issuer, PAR/token/consent contract, scopes and mTLS requirements. Keep the production gate disabled.

The [2026-10-27 bank-supplied sandbox assessment](bancolombia-sandbox-handoff-1266.md) now records
concrete AIS request examples and template coordinates corroborated by anonymous public discovery.
It distinguishes server-advertised RS256/PS256 support from client-specific authentication and
certificate acceptance, and identifies unresolved consent inputs before credentialed execution.

## Existing independent controls

The existing Connections owner publishes browser continuation admission/preparation. Its native
`apps/server/cloudflare/connections/connections.test.ts` suite exercises the public/Core HTTP seam
against isolated D1 bindings, not a fabricated Bancolombia authorization server.

| Control                         | Existing focused behavior                                                                                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same-User session authority     | Another User holding the public locator cannot review or begin that continuation. A public reference alone does not authenticate.                                          |
| Freshness and original lifetime | Expired attempts, stale/revoked sessions and disabled institution admission are refused; exact expiry produces a fresh attempt while retaining stable Connection identity. |
| Origin and input admission      | Hostile browser inputs/origins are refused before consuming a valid attempt; ordinary shared request/Audit pressure applies.                                               |
| Consent/session races           | Preparation rechecks authority at its durable commit when a session is revoked or Consent withdrawn.                                                                       |
| Single use and concurrency      | One concurrent preparation wins; repeat preparation does not activate the Connection or invent a bank request.                                                             |
| Atomic evidence                 | Audit failure rolls back preparation and permits a safe retry; cross-User isolation and expiry/retention preserve owning boundaries.                                       |
| Truthful state                  | A prepared execution remains Connecting. Neither the existing browser preparation nor the registration callback claims successful bank authorization or Active state.      |

These controls should be reused by the bank continuation, not replaced by a second attempt/session
system. Source inspection is distinct from a passing test; record the actual suite result and exact
revision with the implementation evidence. This assessment itself starts no public browser flow.

## Work that still needs accepted bank semantics

Matching signing-key possession and sandbox application authentication are now verified by the
protected [application-authentication evidence](bancolombia-sandbox-handoff-1266.md#protected-application-authentication).
The successful hosted inspection is GitHub Actions run `40532418058` at revision
`ab3ea90e72ce09bc31075324e50b3962483d279d`. This proves the existing RS256 signing key and
certificate-backed client-credentials exchange, not consent creation or a User authorization.

## Implemented sandbox preparation

The existing attempt now owns a private D1 authorization record. A single durable claim binds the
fresh session, same User and current Fidy Consent before bank I/O. The record retains the immutable permissions/history/expiry intent, the returned bank ConsentId,
the S256 verifier and state/nonce digests; neither private proof nor signing material enters browser output.
A claimed request cannot be submitted again. Bank execution occurs outside the D1 atomic unit,
then settles to a bounded handoff or a failed, non-retryable result. Expiry clears the verifier and
handoff, and User erasure includes the private record.

Core reuses the certificate-backed HTTP and RS256 signing boundary to acquire an application token,
create the exact configured consent, record its identifier durably, and only then submit PAR.
A failed or mismatched consent response, or failure to record its identifier, prevents PAR. Discovery must match fixed sandbox issuer, token, authorization, PAR and mTLS
coordinates and advertise S256. Responses and deadlines are bounded; redirects, malformed responses
and uncertain mutations fail closed. The browser receives only a validated authorization URL and
its deadline, remains Connecting, and can leave without authorizing. Only an explicit Core
ResourceLimited non-admission receives bounded pacing; uncertain submissions recover by review.

The built-browser fixture exercises consent creation through handoff over the public/Core/D1 path
with synthetic keys and test identity; only the external bank endpoints are controlled. It proves local integration,
not Bancolombia acceptance. The private coordinator can install the real adapter only from a
bounded, matching-User `BANCOLOMBIA_SANDBOX_CONSENT_PROFILE` secret naming the pinned public-contract
digest, explicit intent, assigned financial header and approved synthetic AccountOwner. No such
profile is configured. Production registration remains empty, and the sandbox callback still refuses completion pending #1268.

## Public contract reconciliation — 2026-10-27

The public API Market now exposes downloadable consent and PAR specifications. Read the
[Account Information documentation](https://developer-portal-public-sbx.apps.ambientesbc.com/documentacion/Account%20Information)
and select **Account Access Consents → API**; read
[Open Banking Authorization](https://developer-portal-public-sbx.apps.ambientesbc.com/documentacion/Open%20Banking%20Authorization)
and select **Pushed Authorization Request → API**. The portal's shared `/documentacion/` detail
route does not independently identify the selected API, so retain the navigation and file digest.

| Download                                                                                    | SHA-256                                                            |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `(Ozone) Account Information - Account Access Consents`, OpenAPI 3.0.1, API version 1.0.0   | `b794218bd9dbf50f68b20aa2335e552ecfb5734830a9fc1c36e70622b5928650` |
| `Open Banking Authorization - Pushed Authorization Request`, Swagger 2.0, API version 1.0.0 | `c6135b16474812c05c2f392751ccf9e8a08d41d310d82180af0934450fe17df3` |

The consent specification requires `Data.Permissions` and `Data.AccountOwner`; the latter requires
`SchemeName` and `Identification`. `Name` and `OnBehalfOf` are optional. Omitted history dates request
up to 90 days through the latest available transaction; omitted consent expiry defaults to one year.
Its documented permissions are `ReadAccountsBasic`, `ReadBalances` and `ReadTransactionsDetail`,
whereas the supplied collection uses five differently named permissions. The public create response
is HTTP 200. Its GET path also differs from the collection. Both financial and interaction headers
are required; the financial-header description calls it a transaction correlation identifier,
whereas the collection sources it from the empty `obParticipantId` variable. These are unresolved
client-profile differences, not grounds to invent an assigned participant identifier or substitute
personal data.

The PAR specification requires private-key JWT authentication, state, response type `code`, scope
and S256. It returns `request_uri` and `expires_in`, with success documented as HTTP 200; the supplied
collection checks HTTP 201. The published contract supplies an expiry field, but does not establish
safe replay after an uncertain submission. No uncertain consent or PAR mutation may be blindly
repeated.

The bank's [authorization URL instructions](https://soportedevs.bancolombia.com/hc/es-419/articles/52174225347220-Utilidad-GET-par-auth-code-url)
describe constructing the redirect from the discovered authorization endpoint, client id, response
type, scope and returned request reference. Fidy does not need to call the sample URL-builder
service. The article's production example is not a sandbox destination allowlist.

Before enabling the installed public-contract adapter for #1267 live acceptance, reconcile which
permission names, response statuses and financial-header value apply to Fidy's assigned sandbox
client, and obtain the corresponding approved synthetic AccountOwner/test-login scenario. Existing
Fidy authentication does not supply a bank document number. The inspected client file leaves
`obParticipantId` empty and does not supply that test scenario. Do not request a real document or
reuse a sample identity to conceal that gap. An updated bank specification or test instructions may
resolve these points without any new credential disclosure.

The unresolved consent contract and assigned synthetic test scenario prevent live end-to-end
acceptance and completion of #1267. They do not prevent the installed durable preparation, PAR and
browser controls described above. No new bank consent or live PAR submission has been performed.

## Local verification — 2026-10-27

Focused native Connections, authentication, consent/PAR and configuration suites: 45 tests passed
across four files. Public browser contract and outbound controls: seven tests passed. Browser
transport: 40 tests passed. Built-browser public/Core/D1 acceptance: three journeys passed,
covering consent creation through handoff/replay, shorter PAR expiry/leave, and destination/signing/
transport refusal. These results use synthetic protocol responses and do not certify live bank
acceptance.
