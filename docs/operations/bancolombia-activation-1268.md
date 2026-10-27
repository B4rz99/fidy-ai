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

The selected collection contains no revocation request. Sandbox discovery observed on 2026-10-27
advertises `/token/revoke` and `/introspection` on the fixed sandbox authorization server; that alone
does not establish Fidy's accepted cleanup authentication or consent-revocation semantics. Do not
guess a consent DELETE endpoint or report cleanup complete from local deletion. Bank-side cleanup
and live response compatibility remain explicit verification items for issue closure.

## Bank clarification needed

The public [Access Token Management documentation](https://api-portal-external.apps.bancolombia.com/api/open-finance/open-banking-authorization/open-finance/open-finance/1.0.0/access-token-management)
was checked on 2026-10-27 and displayed “Aún no tenemos documentación disponible para esta API.”
The support collection remains authoritative; discovery endpoint names alone are not a replacement
for an accepted cleanup request. The outstanding technical question is:

> Hola, estoy completando la integración de Fidy con el sandbox. ¿Me puedes compartir las solicitudes
> de Postman para revocar los access/refresh tokens y el consentimiento de cuentas? Necesito confirmar
> el endpoint, método, body, autenticación y cómo comprobar que el acceso quedó revocado. También,
> si el intercambio del código termina en timeout y no recibo los tokens, ¿cómo debo cancelar o
> reconciliar la autorización usando el ConsentId? Si es posible, incluye ejemplos de las respuestas
> de consulta del consentimiento y de cuentas, con su paginación. Gracias.

No credentials, tokens, bank login details or personal customer data are needed in this request.

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
