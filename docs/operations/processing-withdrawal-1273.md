# Processing Consent withdrawal — #1273

Implementation evidence dated 2026-10-14. This is the authenticated withdrawal slice of
[#1273](https://github.com/B4rz99/fidy-ai/issues/1273), not completion of that issue or a
legal/production acceptance record.

## User control

`/settings/privacy` is reachable independently of ordinary canonical access. It shows the
same-User processing Consent, requires explicit confirmation before withdrawal, and displays
a durable reference and UTC occurrence time. The published rights-request contact remains
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

## Current cutoff and remaining review

The product owner selected this cutoff on 2026-10-14: when authenticated withdrawal commits,
no waiting or new consent-dependent work may start. An already-running, admitted hosted Turn
may finish under its existing bounded basis; withdrawal does not extend that Turn or authorize
its replay as a new Turn. Unstarted queued Ingestion and scheduled work require current Consent
at their native action. Privacy requests and necessary security controls remain available.
This is the product decision, not a record of legal approval or a promise of physical erasure.

The native hosted regression withdraws through the authenticated Consent owner during model
execution, proves the admitted reply can complete, and proves the next Turn is refused before
another model call or Transcript append. Existing native tests cover abandoned Pending recovery,
queued email dispatch, prepared publication and due reminder refusal. Receipt of queued material
is not admission to a hosted Turn.

Ordinary consent-dependent actions and later hosted Turn admission recheck withdrawn standing.
The existing architecture allows an already-admitted Pending hosted Turn to retain its bounded
historical basis and finish after withdrawal. The UI states that limitation. See
[server authority](../../apps/server/ARCHITECTURE.md), [domain timing](../../GLOSSARY.md) and
[security consent timing](../../SECURITY_STANDARDS.md).

The operator reported approval of the proposed bank-access arrangement. That does not verify
legal approval of this precise Pending Turn cutoff. #1273 remains open pending the applicable
legal/architecture review and any resulting change. Withdrawal does not physically erase data,
cancel Subscription renewal, revoke individual credentials or establish bank suppression coverage.

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

Still required by #1273: review of the request/identity-verification procedure, approved private
evidence storage and retention, applicable calendar/classification and deadlines, reviewed
in-flight cutoff, tracked erasure handoff and operator dry run. A displayed email address
does not establish those procedures operate. No deployment, live Titular request, customer
deletion or external notification was performed.
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
