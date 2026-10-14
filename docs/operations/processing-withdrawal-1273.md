# Processing Consent withdrawal — #1273

Implementation evidence dated 2026-10-14. This is the authenticated withdrawal slice of
[#1273](https://github.com/B4rz99/fidy-ai/issues/1273), not completion of that issue or a
legal/production acceptance record.

## User control

`/settings/privacy` is reachable independently of ordinary canonical access. It shows the
same-User processing Consent, requires explicit confirmation before withdrawal, and displays
a durable reference and a readable date in Colombia time. The published rights-request contact remains
visible without authentication. No paid plan or renewed Consent is required for this control.
“Consultar prueba” now obtains the exact saved authorization from the Consent owner at
`GET /web/consent/authorization`. Its live same-User proof is rechecked in the native read, the
saved JSON is bounded before projection, and invalid evidence never becomes an empty success.
The copied disclosure remains available after withdrawal without granting ordinary processing.

The server-declared browser transport is separate from canonical operations and agent tools.
Public ingress forwards cookie-only authority through private Core; the existing User
coordinator serializes withdrawal. D1 rechecks the exact User, session digest, revocation and
expiry while appending existing withdrawal evidence and metadata-only Audit. Retries return
the original receipt without another withdrawal or success Audit. Receipts contain no
credentials, financial contents or historical disclosure bodies.

Invalid authority, confirmation, unexpected fields, query parameters, methods and origins
cannot withdraw. Storage/Audit failure rolls back the batch. An uncertain browser result
never reports completion or automatically replays the mutation; the User explicitly rereads
authoritative status before a fresh confirmed attempt.

## Approved cutoff

On 2026-10-14 the product owner confirmed that specific work already durably queued or admitted
before authenticated withdrawal may finish, and reported legal approval. This records that
confirmation rather than an independent legal opinion. After withdrawal commits, no new
consent-dependent operation or scheduled occurrence is admitted.

Bounded continuation uses the exact same-User unfinished native item, its original lifetime,
terminal-state and replay protections. It never relies on a Queue payload or recurring schedule
alone. Forwarded email retains its queued receipt and original expiry; storing reservations
cannot publish after withdrawal. Statement submissions retain their original native admission.
Frozen proactive/weekly deliveries and queued weekly questions retain their exact outbox/intent
identity. Independently revoked category grants, changed recipient associations, expiry and provider
one-shot claims still block execution. New generation continues to require current Consent.
An already-admitted hosted Turn retains its bounded model/tool budget; the next Turn is refused.
Privacy requests, authentication and necessary security controls remain available.

See [operator procedure](titular-requests-1273.md), [server authority](../../apps/server/ARCHITECTURE.md),
[domain timing](../../GLOSSARY.md) and [security consent timing](../../SECURITY_STANDARDS.md).
Withdrawal does not physically erase data, cancel Subscription renewal or revoke individual credentials.

## Verification and outstanding work

- `cloudflare/consent/browser.test.ts` exercises real public/Core ingress, the existing
  coordinator and isolated native D1: two-User isolation, concurrent replay, rejected ordinary
  work, a protected statement prepared before withdrawal, origin/input/proof refusal,
  expired/wrong-coordinator admission and atomic Audit failure/recovery.
- `e2e/privacy.spec.ts` exercises the built browser through real Core for an independent
  expired-trial User: explicit confirmation, receipt recovery after reload and privacy access
  after ordinary work is refused. A presentation fixture proves uncertain delivery causes
  neither automatic repeated POST nor false completion.

The [operator procedure and private register](titular-requests-1273.md) implement manual case
tracking, source-backed provisional targets, scoped evidence references, delivery outcomes and
erasure handoff. [Disposable CLI evidence](titular-requests-dry-run-1273.json) is distinct from live intake.
Native and built-browser tests demonstrate scoped access to the real saved authorization.

Legal approval and the sole-operator decision have been confirmed by the product owner.
Production release, actual restricted operator storage configuration and a complete operator rehearsal
remain release evidence. The supported verification paths use existing fresh sign-in and recovery;
unsupported entitlement/representative cases remain tracked without granting disclosure authority.
No deployment, live Titular request, customer deletion or further external notification was performed.
Explicit access to visible effective Transactions now has executable privacy-purpose owner authority
at `POST /web/privacy/transactions`, with fresh same-User proof and atomic Audit after withdrawal.
The built-browser journey obtains that actual owner result and visibly delivers it, then exercises
the native private case-register CLI through failed/uncertain delivery, confirmation and replay.
Other owners' data, raw retained evidence, deleted/suppressed originals and correction must retain
their actual requested scope; this bounded access projection is not a full personal-data export.

Local verification passed: 41 Consent/Connections tests, 24 Consent/reminder/weekly tests,
38 infrastructure/edge-policy tests and two built-browser privacy tests. These sets overlap;
their counts are not a distinct-test total. The full static group passes all checks except
the existing dependency policy, which requires admitted patch updates to shadcn 4.21.4 and
@babel/parser and @babel/traverse 8.0.7. No dependency deferral or exception was added.
