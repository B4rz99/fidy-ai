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
fresh session, same User and current Fidy Consent before bank I/O. The record retains the immutable permissions and bank-default history/expiry intent, the returned bank ConsentId,
the S256 verifier and state digest; neither private proof nor signing material enters browser output.
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
bounded, matching-User `BANCOLOMBIA_SANDBOX_CONSENT_PROFILE` secret naming the pinned support-corrected
revision, explicit intent and supplied test AccountOwner. Temporary one-User profiles are configured only for bounded live tests. Production registration remains empty, and the sandbox callback still refuses completion pending #1268.

## Accepted support collection — 2026-10-27

The User confirmed that Bancolombia technical support's supplied Postman collection is authoritative
for this sandbox client. Its SHA-256 is
`869a3da43fed9043b734e9be698e49234738cb3b1a26ca79cde3f606eb3fcd62`.
The supplied AccountOwner and representative identify the bank-provided test scenario; a separate
customer approval or bank login is not a prerequisite for #1267's authorization handoff.
Bank login, approval and callback completion belong to #1268.

Bancolombia technical support subsequently corrected the collection's obsolete consent body.
The accepted override contains only `Data.Permissions` and `Data.AccountOwner`. Permissions are
`ReadAccountsBasic`, `ReadBalances`, `ReadTransactionsDetail`, `ReadTransactionsCredits` and
`ReadTransactionsDebits`. Neither historical dates nor `OnBehalfOf` are sent; history and consent
expiry are left to the bank. Private profiles must select revision
`bancolombia-sandbox-consent-2026-10-27`; the original collection-only revision is refused. Consent creation accepts HTTP 200/201 and
requires Data.ConsentId; optional echoed permissions must match when present. PAR
requires HTTP 201, private-key JWT and S256, with no nonce because this collection does not use one.
Support confirmed that `obParticipantId` is unused for this case and may remain empty; the blank
`x-fapi-financial-id` value is valid. The customer-IP example contains a date instead of an IP address; that optional header
is omitted. The sample external signing helper and verifier logging are never executed.

A Core-only redacted profile pins this corrected revision, the test identity, one Fidy User and a
fixed admission window of at most one hour. Browser review, initiation and preparation recheck the
same User and window. The provider adapter rechecks it immediately before bank work and bounds the
handoff by its expiry. Expired admission cannot reopen preparation. Existing bank consent evidence
continues to block whole-User erasure pending institution suppression even after admission expires.
The production institution registry remains empty.

The deployed previous body received HTTP 400 during live consent creation on 2026-10-27 at
20:20:28 UTC. Signing, discovery, mTLS and application-token exchange passed protected inspection
[40577409689](https://github.com/B4rz99/fidy-ai/actions/runs/40577409689) at revision
`cb88b8e112bed08381c9c502e1a973b1c55f8119`. The bank's body correction supersedes that failed
request contract. Live consent/PAR acceptance of the corrected body remains to be verified; local
tests control the external bank and do not establish Bancolombia acceptance.

Test-bank login credentials remain with the User. They are not Fidy application credentials and
are unnecessary for #1267's handoff; customer login, approval and callback belong to #1268.

## Local verification — 2026-10-27

Focused native Connections, authentication, consent/PAR and configuration suites: 46 tests passed
across four files. Public browser contract and outbound controls: seven tests passed. Browser
transport: 40 tests passed. Built-browser public/Core/D1 acceptance: three journeys passed,
covering consent creation through handoff/replay, shorter PAR expiry/leave, and destination/signing/
transport refusal. These results use synthetic protocol responses and do not certify live bank
acceptance.
