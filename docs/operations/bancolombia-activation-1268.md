# Bancolombia sandbox activation — #1268

## Accepted protocol

The support-supplied `TPPs Open Banking Update.postman_collection.json` is the selected bank profile
(SHA-256 `869a3da43fed9043b734e9be698e49234738cb3b1a26ca79cde3f606eb3fcd62`), with the
[corrected consent body](bancolombia-authorization-preparation-1267.md). Authorization-code exchange
uses the collection's `scope=accounts`, exact registered redirect, original S256 verifier and fresh
RS256 private-key assertion over private Core mTLS. Fidy never collects bank login credentials.

The exact GET callback is `/connections/bancolombia/sandbox/callback`. State selects an originating
attempt only within the original live Fidy WebSession. A durable grant claim and Audit commit before
exchange; the verifier and handoff are then removed. No callback retries an exchange, including
after a lost response or Worker restart. Expired, ended, superseded, denied, foreign-User and replayed
callbacks cannot install new authority. Callback URLs do not enter Work telemetry. The browser
receives a fixed, parameter-free `/connections/result` redirect with no-store/no-referrer policy.

Top-level bank redirects cannot send Fidy's mounted-page binding header. This exact callback instead
requires its independent state proof and original live session. It does not use the ordinary
canonical-operation burst allowance: the durable, latest-generation claim bounds bank execution to
one attempt. Query length, token/JWKS response bytes, signing algorithms, Account count, page count,
provider call deadlines and the complete activation lifetime are independently bounded.

Bank issuer, token and signing-key destinations are pinned to the sandbox discovery profile.
Only RS256/PS256 bank identity signatures are accepted; issuer, client audience, time claims and
applicable authorization-code/access-token/state hashes are checked. The bank subject never becomes
a Fidy User identity. Bank consent identity, authorized status and exact requested permissions are
checked before and after complete Account discovery. Local session, processing Consent, admission
window and latest Connecting generation are rechecked at atomic settlement. A processing Consent
withdrawal after the claim invalidates that attempt even if Consent is renewed before settlement.
Pagination reconciles declared totals across all pages and requires a contiguous page sequence;
contradictory totals and premature completion cannot activate a partial Account set.

## Credential custody

`BANCOLOMBIA_SANDBOX_GRANT_KEY` is an independent, canonical unpadded base64url encoding of 32 random
bytes. It is supplied only as a protected Core secret. It is neither the registered signing key nor
the mTLS private key. Preserve it while retained grants exist; replacing it without re-encrypting
those grants makes their credentials unrecoverable. Never put it in evidence, a browser or Git.

`connection_grants` stores one row per claimed attempt. A successful token response is quarantined
before signed-identity validation or Account reads. The minimum recoverable payload is access token,
optional refresh token and access-token expiry. ID tokens are transient. The envelope format is
`v1.<base64url 12-byte nonce>.<base64url AES-GCM ciphertext and tag>` with a fresh random nonce.

Authenticated additional data is the JSON string array, in this order:

1. `fidy-bank-grant-v1`
2. stable Fidy User ID
3. stable Connection ID
4. originating attempt ID
5. `bancolombia`
6. `sandbox`
7. configured registered client ID
8. immutable bank ConsentId
9. immutable serialized consent intent

Copying an envelope to another purpose cannot authenticate. The key is absent from D1, ingress,
ordinary projections, agent inputs and browser responses. Current Account reads expose Fidy IDs and
their Connection ID; they never expose provider account identifiers, consent references or tokens.
Account identities survive reauthorization; an Account omitted from the new authorized set is not
returned by current Account reads. Historical Transactions and Balances are separate work (#306/#307).

## Failure and restart disposition

Final grant activation, the complete Account set, Connection state and completion Audit commit
together. Failed discovery or settlement leaves no partially installed Accounts. Known failure marks
the exact claim `cleanup_required` and the current Connection `Action required`; late failures never
overwrite a newer generation or an Ended Connection. Scheduled retention also classifies abandoned
claims after their original attempt expires, without repeating the code exchange.

Cleanup-required credentials are encrypted and unavailable to ordinary Account reads or bank work.
Their immutable ConsentId and intent remain tracked even if an exchange response was lost and no
token was received. They are not evidence of successful bank-side revocation. Whole-User erasure
retains its existing bank-suppression block until verified institution cleanup is available (#313).

The selected collection contains no revocation request. The rechecked public contracts do provide
Account response examples: `Data.AccountReport`, nested `Data.Links`, and `pageNumber`. Activation
now follows that shape, checks contiguous pages and consistent `Last` links, and rejects untrusted
destinations. The support-selected consent paths and corrected creation body remain authoritative.

Sandbox discovery advertises fixed `/token/revoke` and `/introspection` mTLS endpoints. OAuth
specifies their form bodies; RFC 8414 defaults absent revocation authentication metadata to Basic,
while introspection authentication must be determined separately. A controlled 2026-10-27 probe
using Fidy's supplied Basic credentials and client certificate returned HTTP 400 `invalid_client`
for token issuance, introspection and revocation. The latter two used an explicitly invalid probe
token; no customer consent or Account was touched and no application token was issued.

The existing protected Core sandbox verification now tests the registered `private_key_jwt`
method without extracting its signing key: issue one application token, prove it active through
introspection, revoke it once, then prove it inactive. Every call uses a fresh assertion, pinned
endpoints, the certificate binding, bounded responses, and no automatic retry. A revocation HTTP
200 alone, an initially inactive token, failed introspection, a token still active afterwards, or natural token expiry during the check
cannot pass. This proves only application-token behavior; it does not establish refresh-token
cleanup, customer-grant cleanup or ConsentId cancellation.

The [protected release](https://github.com/B4rz99/fidy-ai/actions/runs/40604041447) completed on
2026-10-27 at revision `127ad191f29b288260876b63d3d4ada20866d8e1` with sandbox customer admission
disabled. The subsequent [signed live verification](https://github.com/B4rz99/fidy-ai/actions/runs/40604618334)
ran with `verify_bancolombia_sandbox=true` and passed the active → revoke → inactive check. The
registered JWT/mTLS application-token path is verified; the Basic rejection remains recorded above.
No signing key or bank token was exported.

## Held-grant recovery

Known tokens are retained before validating the complete exchange response. If retaining them fails,
Fidy attempts immediate bank cleanup; it still rejects activation, and an unsuccessful cleanup cannot
be reported as resolved. Failed and superseded grants with an encrypted envelope are eligible for
private scheduled cleanup.
One due grant is leased per five-minute tick; the two-minute lease prevents competing ticks from
cleaning the same attempt. A failed or interrupted attempt retains its envelope and waits five
minutes before retry. A crash that bypasses the failure handler is recoverable after lease expiry.
Discovery and each destination remain pinned, and cleanup uses the same Core mTLS and signing key
independently of browser sessions, processing Consent standing, or the sandbox admission window.

Before any revocation, cleanup inspects both tokens and durably records each positive active result
under the exact live lease. It then attempts the held refresh token first, then the access token even
if refresh cleanup fails. Each token requires authenticated introspection, revocation, and inactive
introspection afterwards. An initially inactive token is insufficient without its retained positive
baseline; an access token past its validated original expiry can instead rely on that expiry. A
malformed exchange expiry is never treated as evidence that a received token has already expired.
Both must finish before the exact leased envelope is destroyed and its completion timestamp is
recorded. Already-inactive tokens with that proof can be processed after a prior ambiguous revocation;
no new token or refresh grant is requested. Active grants, another User's grants, and newer attempt
results are not eligible. The database guards and encryption purpose bind every operation to its
original User, Connection, attempt, client, consent, and intent.

The marker records only verified invalidation of held tokens, not cancellation of bank consent.
A claim with no envelope remains unresolved and cannot acquire a cleanup completion timestamp.
Whole-User erasure remains blocked under #313; the pending ConsentId procedure is unchanged.

## Remaining verification

Repeat application-token verification through the existing `production-inspect.yml` workflow with
`verify_bancolombia_sandbox=true` after a relevant authentication/profile change. Only Core holds
the registered signing key; do not extract it or recreate the deleted signing-proof workflow. No
customer test profile is required for this application-token verification.

Customer access/refresh-grant cleanup is implemented for held credentials; live customer-token
verification is still required before general sandbox customer admission. The successful application-token check is not evidence for those token kinds
or for a different grant's isolation. An uncertain exchange that returns no token remains separate:
reviewed public consent contracts define creation and retrieval, but no TPP cancellation operation.
They describe revocation through the bank's interface without specifying an API request for Fidy.
A read-only mTLS `OPTIONS` check on 2026-10-27 returned HTTP 200 with `Allow: POST` on the
support-selected collection route and `Allow: GET, HEAD` on an explicitly invalid individual
consent-resource route. Neither advertised cancellation. Local system DNS failed for the supplied
resource host; public Cloudflare DNS resolved it, and the check retained normal HTTPS hostname and
certificate verification. No customer resource was read or changed. These responses do not rule out
a separate cancellation endpoint. The unresolved bank-specific question is:

> ¿Cómo debe Fidy cancelar o reconciliar un ConsentId de cuentas si el intercambio del código pudo
> completarse, pero por un timeout no recibimos los tokens? Necesitamos el procedimiento soportado
> y cómo comprobar que no queda acceso utilizable.

Sources and recovered contract hashes are recorded in
[the protocol research](../research/bancolombia-cleanup-public-protocol-1268.md). The broader support
question previously drafted here is superseded; account examples and generic OAuth request details
are already available.

## Verification

Provider-HTTP tests exercise the real assertion/token/identity/consent/discovery implementation.
Public/Core/native-D1 tests cover success, Account reads and isolation, replay/concurrency,
reauthorization identity stability, expired PAR versus original attempt lifetime, invalid bank
identity, changed consent, malformed/duplicate/partial discovery, uncertain exchange, withdrawal
and atomic Audit failure. The built browser follows a synthetic bank handoff and callback to failed
and Active result pages. Neither suite seeds an Active Connection as success evidence.

The result page uses the application shell and reads current Connection/Account facts. It does not
claim that transaction or balance import has run. Production institution registration remains empty.
Live sandbox validation requires a new bank approval after this callback implementation is released;
the previous registration-only callback discarded its code and cannot be replayed.
