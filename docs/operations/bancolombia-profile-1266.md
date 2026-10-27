# Bancolombia sandbox profile and provisioning — #1266

Observed **2026-10-19**. This is the working technical contract/evidence worksheet for
[#1266](https://github.com/B4rz99/fidy-ai/issues/1266), not a claim of bank acceptance.
The [2026-10-27 sandbox handoff assessment](bancolombia-sandbox-handoff-1266.md) supersedes
the pending-access status below: the owner reports sandbox provisioning and supplied the bank's
collection/environment template. Public discovery matches the template and advertises RS256/PS256;
client-specific authentication and certificate acceptance remain unverified. No credentialed bank
flow has been executed.

The production institution gate remains disabled. Fidy's production-hosted registration URLs
publish sandbox metadata; their hostname does not make this a production bank client.

Use the [registration runbook](bancolombia-sandbox-registration.md),
[current public-source recheck](../research/bancolombia-profile-public-recheck-1266.md) and
[historical source record](../research/davivienda-api-237.md#14-bancolombia-baseline).
Current public guidance, historical downloaded product files and actual accepted provisioning
are different evidence classes. A historical example is not an accepted deployment contract.

## Fidy registration evidence

Restricted read-only preflight receipt `4823a0df-6030-44c0-98e4-745ce38778d9` records
2026-10-19T12:16:33Z, checked source revision
`5542e4c943f36d61a863493b29b7bbe94dc3f6b8` and served revision
`99fc5047bd422f9f66db20fb447b04a08a15d3f7`. These observations did not deploy or change anything.
Restricted supplement `25d68661-fa0d-4f9b-b4f0-a5f78097eeb1` records protected-secret metadata and the bounded
company-mail search; neither is accepted bank registration or signing possession proof.

| Item                          | Observed evidence                                                                                                                                                                                                             | Acceptance boundary                                                                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requested product/environment | Owner reports Account Information/AISP access request pending; registration runbook selects Sandbox.                                                                                                                          | No accepted Fidy sandbox client, scope grant or provisioning receipt established.                                                                                                                       |
| Public JWKS                   | `https://api.fidyapp.com/connections/bancolombia/sandbox/jwks`: GET 200; one RSA 3072-bit signing key, RS256, public fields only, matching checked source; `kid` is `bancolombia-sandbox-2026-10-08`.                         | Reachability is verified; bank registration/acceptance of that exact key/URL is not.                                                                                                                    |
| Redirect                      | `https://api.fidyapp.com/connections/bancolombia/sandbox/callback`: clean GET 503, deliberately unavailable. A synthetic, non-authorizing query received 303 to the same fixed path without query, with no-store/no-referrer. | This is not a successful callback, attempt validation, code exchange or bank round trip. Exact bank redirect registration is unverified.                                                                |
| Signing-key custody           | GitHub metadata lists `BANCOLOMBIA_SANDBOX_PRIVATE_KEY_PEM` in protected `production`, updated 2026-10-08T21:24:57Z. No secret value was accessed. The runbook's local `.env.bancolombia.local` was absent in this worktree.  | A secret name/history does not prove its current value matches the public key or is installed in private Core. Do not regenerate or replace it to fill this gap.                                        |
| Bank client and issuer        | No accepted client ID, issuer/discovery assignment, enabled grants or actual Account Information scope evidenced in the checked records. A focused company-mail search found no matching acceptance message.                  | Search scope is not proof that no approval exists in another mailbox or portal. Bank onboarding supplies the authoritative registration receipt. Keep any actual client/account identifiers restricted. |
| Production gate               | Read-only D1 inspection returned `connection_institution_gate.enabled = 0` for Bancolombia. Migration 0063 defaults it to zero; Connection admission consults this gate.                                                      | Gate remained disabled. Neither registration URLs nor sandbox success authorize enabling it.                                                                                                            |

## Required accepted profile

The source recheck records what is currently public. Complete the following with the applicable,
versioned bank profile and accepted sandbox registration, not inferred hostnames or sample IDs.

| Contract item                      | Specific missing evidence                                                                                                                                        | Responsible party / next action                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Registration                       | Accepted sandbox client, registration status, exact redirect/JWKS registration, granted AISP scopes, enabled grant/authentication methods.                       | Bank onboarding supplies acceptance; sole Fidy operator retains minimized receipt.                                                    |
| Discovery                          | Exact issuer and discovery URL for that client; accepted issuer/audience values and any mTLS endpoint aliases.                                                   | Bank supplies profile; Fidy compares discovery against the accepted issuer before implementation.                                     |
| Consent                            | Exact create/read/update/revoke operations, permissions, ConsentId binding, expiration and rejection/revocation behavior.                                        | Bank resolves the client-applicable contract; Fidy proves the lifecycle with synthetic authorized scenarios under #1270.              |
| PAR and authorization              | Exact endpoints, PAR authentication and required fields, request URI lifetime/single-use rules, state/nonce and redirect requirements.                           | Bank profile owner; Fidy binds each request to one same-User ConnectionAttempt under #1267.                                           |
| Code exchange and refresh          | Exact token endpoint, private-key JWT audience/lifetime/clock tolerance/JTI policy, S256 requirements, refresh rotation/replay/expiry and error meanings.        | Bank profile owner; Fidy implements only the confirmed lifecycle under #1267–#1269.                                                   |
| Accounts / Balances / Transactions | Exact product hosts/paths/version, token audience and consent/scopes; authoritative wire schemas and error dictionaries.                                         | Bank resolves product OAS/authentication conflicts; Fidy validates responses at its adapter boundary.                                 |
| Revocation                         | Exact institution consent/token revocation endpoints, required authority and expected post-revocation behavior.                                                  | Bank confirms supported operations; Fidy keeps Connection ending distinct from a merely local UI action.                              |
| Transport                          | Required endpoints using mTLS, certificate type/identity/issuer/chain/key usage, registration/renewal/revocation process, TLS policy and egress/IP requirements. | Bank supplies accepted transport policy; Fidy owns protected key installation and deployment proof. No CA or FAPI version is assumed. |
| Token binding                      | Whether access/refresh tokens are certificate-bound and which certificate/alias each call must use.                                                              | Bank profile owner; test independently of private-key JWT signing. HTTPS and JWKS alone do not prove mTLS.                            |
| Operating limits                   | Aggregate quota scope, rate/concurrency limits, polling policy, 429/Retry-After/backoff, timeout/retry and consent-request idempotency.                          | Bank confirms normative limits; Fidy records bounded scheduling and retry policy before live access.                                  |

## Data semantics that must be resolved

Historical official product files are summarized in the linked source record. Preserve these
questions until the current accepted profile and bounded sandbox observations resolve them:

- **Consent/history:** 90-day prose, a three-month exception and a four-month query window conflict.
  Obtain separate consent duration, available historical depth and per-request date limits, including
  date boundaries/time zone and inclusive/exclusive semantics.
- **Account identity:** confirm AccountIdentification stability across refresh, renewed authorization
  and bank environment changes; reconcile CAAC/CACC dictionary/example disagreement. Do not use a
  display label or Account number as Fidy identity.
- **Completed movements:** historical STLD means settled; FNLD may not be settled. Confirm the full
  current status dictionary, transitions, reversal representation, and BookingDateTime versus
  ValueDateTime. Do not admit provisional/rejected/cancelled movements as Transactions.
- **Stable movement identity:** historical TransactionIdentification is described as unique, but
  its stability across overlapping windows, pages, retries and reauthorization is not proven.
- **Available Balance:** AVLB and TPBL are distinct historical types. Confirm AVLB's current wire
  shape, Currency, observation/as-of time and meaning. The historical MultilateralBalance OAS has
  an array/schema inconsistency; TPBL is not an available-Balance substitute.
- **Traversal:** historical pageNumber, up to 40 records and Next/Last links do not establish a
  stable snapshot. Confirm ordering, tie-breaker, terminal condition, empty/error-page behavior,
  concurrent-change behavior and safe overlapping-window traversal.
- **Authentication conflict:** historical product OAS client-credentials declarations conflict with
  User-consent/authorization-code prose. Do not treat an application token as permission to read
  a User's Accounts. Bank confirmation and synthetic sandbox evidence must resolve the discrepancy.
- **Limits:** the historical `150/1second` header is an example, not a verified aggregate contract.

## Safe signing proof and separate rotation lifecycles

The signing possession proof is **not yet performed**. The maintainer can prepare it without bank
traffic: inside the existing protected secret execution environment, fetch the approved public JWKS,
select the exact expected key, sign a fresh domain-separated random challenge using RS256 and the
existing protected private key, and verify locally against that public key. The challenge must not
be a bank assertion or contain `client_id`, audience or authorization payloads. Do not emit private
material, the signature, raw challenge or environment values. Retain only time, immutable workflow/
revision, public-key fingerprint/kid and success/failure in restricted evidence. A failed proof must
not trigger automatic replacement. This is key possession, not bank registration or mTLS proof.
The absent local file is not evidence that the protected key is lost; do not extract the GitHub secret.

The sole Fidy operator owns both lifecycles; bank onboarding owns acceptance/re-registration:

1. **Signing-key rotation:** preserve the current key; establish bank key-overlap/cache rules; publish
   the new public key and obtain registration acceptance; prove protected possession and deploy
   the matching signer; retire the old key only under the accepted overlap/revocation rules.
2. **Transport-certificate rotation:** separately record accepted certificate chain, expiry, trust,
   endpoint coverage and any token binding; provision/register the successor; prove TLS handshakes
   and token lifecycle under the bank's policy before retiring/revoking its predecessor.

No accepted mTLS certificate or expiry is evidenced here. Signing `kid` is not certificate expiry.
Do not purchase a certificate or invent a renewal interval until the bank's policy is established.

## Sandbox proof and production handoff

#1270 needs bank-authorized synthetic identities and scenarios covering authorization acceptance/
rejection, expired/replayed state and codes, PAR/PKCE failures, refresh rotation and invalidation,
consent expiry/revocation, multiple Accounts/Currencies, empty/multipage movement history, status
transitions, expired/rotated signing keys/certificates, throttling and transient failures. Obtain
what the bank supports and its expected outcomes before promising every scenario is available.
Do not use real customer credentials or another environment to replace missing sandbox access.

Retain exact profile revision, accepted registration reference, tested served release, time and bounded
outcomes privately. Production requires separate bank eligibility/commercial approval, registration,
credentials/certificates, contractual incident routes, limits and any bank-required security/test
acceptance. #1272 owns the legal route; #1275/#1276 own provider/privacy evidence. Sandbox success is
not production eligibility. Unknown protocol-critical cells keep #1266 open and executable bank-flow
work in #1267–#1270 blocked at those dependencies.

## Acceptance status

Public/source research, reachable registration metadata, a read-only disabled-gate check and this
missing-evidence/ownership register can be completed now. Accepted client/profile, bank-specific
certificate policy, protected signing possession proof and authorized bank scenarios are unverified.
No bank contact, credential/certificate provisioning, live bank flow, deployment or gate change was
performed by this review. The checklist is a record of gaps, not successful provisioning.
