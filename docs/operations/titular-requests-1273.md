# Titular requests — operator procedure for #1273

Status: implementation and procedure draft, dated 2026-10-14. FIDY S.A.S. must review the
classification, verification, calendar, retention and response procedure before using this with
live requests. The local register is working software; it is not legal signoff, a production
privacy authority, or proof that a live claimant's full request has been completed. Keep #1273 open until the
live acceptance evidence and withdrawal cutoff below have been reviewed.

## Intake and storage

Use the published `obarboza@fidyapp.com` channel. Intake is free; never require a purchase, a new
User, a login or renewed Consent to receive a request. Preserve the original received instant,
request scope and correspondence in restricted evidence storage. Acknowledge with an opaque case
reference and the responsible operator. A receipt is not proof of claimant identity.

Run `bun run titular:requests /absolute/private/directory` with one JSON request on stdin.
Use an encrypted managed operator volume, outside every Git repository and shared/synced public
folder. The tool requires POSIX ownership, a 0700 directory and 0600 database, refuses links and
foreign databases, and keeps at most 1,000 cases / 20,000 history entries / approximately 20 MiB.
It fails closed when capacity or platform requirements are unavailable. Windows is unsupported.
The command has no server credentials, provider connections, product database access or delivery
capability. No telemetry is needed: its work is local, and failures return only closed classes.

The register stores UUID references, request type, requester class, received time, accountable
owner, revisions and workflow facts. Keep the UUID-to-evidence mapping private. Do not place email
addresses, names, identity documents, financial records, government identifiers, passwords, recovery
codes, PATs, cookies, URLs, message bodies or arbitrary notes in its metadata. Unknown fields are
rejected before opening storage. The tool accepts at most 4 KiB within ten seconds; do not pipe
original correspondence into it. Input files and backups need the same restrictions as the register.
It is a manual ledger; recording verification, an owner result or delivery references does not
perform or authorize any of those effects.

Example using disposable references only:

```json
{
  "operation": "Apply",
  "command": {
    "action": "Receive",
    "commandId": "20000000-0000-4000-8000-000000000001",
    "caseId": "10000000-0000-4000-8000-000000000001",
    "ownerRef": "20000000-0000-4000-8000-000000000002",
    "requestRef": "20000000-0000-4000-8000-000000000003",
    "scopeRef": "20000000-0000-4000-8000-000000000018",
    "requester": "NonUser",
    "kind": "Access",
    "receivedAtMs": 1791565200000
  }
}
```

Create fresh UUIDs for real command/case/evidence references in the approved private system. Each
subsequent command supplies the case's last observed `revision`. Read it with
`{"operation":"Read","caseId":"…"}`. Retrying the _identical_ commandId and command returns its
original receipt without new history. A changed command with that id, or a stale revision, refuses.
After losing output, reread the case or replay the original command; never invent a new command id
until the actual result is understood. Local history and the case projection commit together.

## Classification and deadlines

The general statutory baseline is [Ley 1581/2012, Articles 13–16](https://cancilleria.gov.co/normograma/compilacion/docs/ley_1581_2012.htm).
Access, proof of authorization and use explanation are consultations. Correction and complaints are
claims. Have the reviewer confirm how the actual withdrawal/erasure request and any special data
regime fit before treating the software's conservative claim target as the applicable legal deadline.
A shorter special period takes precedence.

Consultations have a ten-working-day response period and at most five additional working days
with reasons and a communicated response date. Claims have fifteen working days from the day after
receipt and at most eight additional working days. An incomplete claim needs a completion request
within five days; two months without the requested completion leads to an abandonment review.
Incompetent recipients transfer and notify within two working days. A complete claim needs the
applicable “reclamo en trámite” annotation within two working days, retained until resolution.
Exhaustion of the consultation/claim procedure precedes the Article 16 SIC complaint route.

The calculator supplies **provisional internal targets**, not a legal determination. It uses the
Bogotá receipt date, counts Saturdays conservatively, excludes Sundays and national holidays, and
counts the consultation receipt day when working. [Ley 51/1983, Article 1](https://cancilleria.gov.co/sites/default/files/Normograma/docs/ley_0051_1983.htm)
provides holiday observances, including Monday transfers and Easter-relative days. This avoids
assuming that every Saturday is excluded; the Fidy reviewer must confirm its business-day treatment.
Only 2026–2027 are supplied. Unknown calendar coverage triggers review, never an invented deadline.
Verification/completeness does not silently reset or suspend the original internal response target.

Monitor open cases every working day. `RequestCompletion` and `RecordCompletion` retain evidence
and their occurrence instants. `completionReview` is calculated from the original completion request;
`claimAnnotation` supplies its provisional target. `RecordClaimAnnotation` records the private evidence
reference and instant, without modifying canonical data. Repeated completion requests cannot reset
the clock, and completion does not reset the response deadline. Never automatically abandon a case.
`Extend` requires notice/reason references, one explicit later response date
within the cap, and recording before the original target expires. It cannot extend twice. Confirm
that the notice was actually delivered; a UUID is not delivery evidence by itself. Escalate incomplete
scope, unverified identity, missing calendar coverage, approaching/overdue targets, failed delivery or
missing owner capability to the accountable owner and legal reviewer. Never postpone silently.

## Identity and purpose verification

Keep intake, verification and product authority distinct. Record a verification artifact only after
its reviewer checks the evidence, subject binding, requested purpose, scope and safe response
destination. The artifact must identify the actual method, verifier, time, conclusion and limitations;
only its opaque reference enters `RecordVerification`. An operator assertion, caller-supplied email,
phone number or financial facts cannot establish authority.

- **User:** use an existing authenticated same-User browser and its ordinary proof mechanisms.
  After withdrawal, the privacy status/receipt transport remains available with a live WebSession.
  Do not ask the User to send their cookie, PAT, browser-private verifier or BackupRecoveryCode
  into correspondence or the case ledger. The separate support-recovery procedure keeps its
  own proof requirements and cannot fabricate a privacy authorization.
- **Non-User Titular:** do not create a User. The reviewer must establish the subject's entitlement
  to the particular held material and lawful request authority through an approved purpose-specific
  method. Receiving an email or recognizing claimed facts is insufficient. The exact alternate
  method and restricted evidence system remain a live-use review gate; this draft does not invent
  a verification credential or accept identity documents into the ordinary register.
- **Representative:** establish both the principal's request authority and the representative's
  independently verified, scope-limited mandate through the reviewed procedure. A forwarded
  email, an uploaded unsigned statement or the representative's own login is insufficient.

If established User proofs are lost, keep the rights request open and escalate the alternate Titular
verification path; do not claim that inability to recover ordinary login removes privacy rights.
Neither alternate privacy verification nor case metadata creates a WebSession or changes User identity.
Do not disclose whether another person's User, records or credentials exist during verification.

## Scoped action and response

For access/correction, obtain the actual scoped result through the applicable owner and its real
proofs; record the restricted result reference with `RecordOwnerResult`. A case entry cannot authorize
a direct D1 query, a foreign-User operation or a canonical call after its Consent basis has ended.
If the necessary privacy-purpose owner authority is not executable, escalate that capability gap;
do not substitute operator access or call an empty result completed access.

Visible effective Transaction access is executable through the existing `/app/transactions` view
(linked from `/settings/privacy`) and
`POST /web/privacy/transactions`, even after withdrawal and expired commercial access. Each page
requires fresh same-User browser proof and atomic Audit; the browser delivers the scoped result
directly to that verified requester. The native response reference traces its privacy Audit; it is
kept out of the ordinary UI, alongside internal Transaction ids.
Pages have at most 100 Transactions, exact Money and explicit continuation. Each page observes
current state; this is not an immutable full-database export. This scope excludes deleted records,
raw capture material, suppressed original members and unrelated owners. Keep a broader request open
until its separately scoped result exists. Correction is a separate owner operation, never a side
effect of access or a case-register command.

For withdrawal, have the proven User use `/settings/privacy`. Its same-User public/Core/coordinator
path rechecks live authority and commits Consent evidence and Audit atomically. Record only the
verified durable receipt reference with `RecordWithdrawal`. Operator-assisted intake cannot bypass
this proof. Withdrawal, individual access revocation, Subscription cancellation and physical erasure
are distinct. The product owner selected on 2026-10-14 that an already-running admitted Turn may
finish, while waiting and new consent-dependent work cannot start after withdrawal commits.
Queued material does not inherit that Turn's historical basis. The legal review remains open;
do not present the product decision as legal approval.

For erasure, prepare a tracked #1274 handoff containing the verified request-authority reference,
scope reference, explicit withdrawal outcome (recorded receipt, not requested, pending or unavailable),
responsible owner and a safe case reference. Store that package privately and use `ReferErasure` for
its opaque reference and explicit `withdrawal` outcome: `{ "status": "Recorded", "reference": "…" }`,
or `{ "status": "NotRequested" }`, `Pending`, or `Unavailable`. The register binds the case's verified
authority and scope into the handoff. A recorded withdrawal must match the case's withdrawal receipt;
an existing receipt cannot be hidden by another outcome. The register never deletes customer data
and always reports `not-performed`.
Lawful holds, residual basis, provider suppression and deletion evidence belong to the erasure owner;
a handoff must not be represented as completed deletion.

Prepare the minimized response in restricted storage. `PrepareResponse` requires recorded verification
and the relevant owner result, withdrawal receipt or erasure handoff. Deliver only through the
reviewed destination bound to the verified requester; do not attach personal data to a newly supplied
address merely because it appears in the original email. Use `DeliveryFailed` or `DeliveryUncertain`
when the outcome is unresolved. Neither closes the response. `RecordResponse` requires an independently
checked delivery receipt reference; a sent request or transport acknowledgement alone is not confirmed
receipt. Generic intake/completion notices can be sent without disclosing held personal data and are
recorded separately from the final scoped response.

## Dry run and live-use gates

The focused register suite exercises real private files/SQLite, intake without a User, stable replay,
rejected personal fields/unsafe permissions/links, storage rollback, scoped workflow prerequisites,
ambiguous delivery, erasure handoff and deadline/extension bounds. Run:

```sh
bun --bun node_modules/vitest/vitest.mjs run --config scripts/vitest.config.ts scripts/titular-requests/runtime.test.ts
```

[Disposable CLI evidence](titular-requests-dry-run-1273.json) records a separate executable register
run. It is simulated intake and manual-fact recording, not an actual privacy-purpose owner export,
published-inbox exercise or verified human operator demonstration. The existing browser/native
withdrawal evidence is in [processing withdrawal](processing-withdrawal-1273.md).

The built-browser privacy journey additionally authenticates an expired-trial disposable User,
withdraws Consent, displays the real Transaction-owner result, and invokes the actual private CLI
register. It uses the native Audit reference for the scoped owner result, records a separate private
visible-delivery witness, proves failed/uncertain states stay unresolved, and confirms/replays the
final case without deletion. This is disposable integration evidence, not live claimant verification
or human legal approval.

Before live use: approve the actual verification/representative method, evidence store, operator
identity mapping, calendar/classification and special-regime rules, case/evidence retention and
lawful-hold procedure, safe delivery destination, executable scoped privacy-purpose access/correction,
and exact withdrawal cutoff. Register capacity does not establish a retention period. Do not retain
live cases indefinitely while waiting for that decision. Perform an operator-led published-channel
dry run with disposable data, including failed destination and ambiguous completion, and retain
its verified minimal receipt. Stage/promote the browser/server release through the normal reviewed
production workflow separately. This implementation authorizes no deployment, live disclosure,
customer erasure, external notification or closure of #1273.

## Concrete operating proposal for review

This proposal supplies decisions to approve or amend; it is not recorded approval.

- **Owner and cadence:** appoint the operator of `obarboza@fidyapp.com` as accountable case owner,
  with a named backup in the private roster. Review pending cases at 09:00 America/Bogota each
  Monday–Saturday while the conservative calendar applies. Escalate missing authority or capability
  immediately, and delivery failure or a response due within two working days on that review.
- **User verification:** freshly authenticate through the existing provider/pairing mechanism.
  Deliver supported owner results in the same browser. Link the native privacy Audit to the restricted
  case evidence without copying its credential or customer content into metadata.
- **Non-User or lost proof:** offer an assisted confidential appointment without creating a User.
  The reviewer independently checks an original identity credential against an authoritative issuer
  or a reviewed identity-verification service, then separately establishes entitlement to the exact
  material. Financial facts and contact addresses supply no identity proof. Retain a minimal signed
  verification conclusion rather than document images or biometrics unless specifically necessary.
  A concrete issuer-checking method, appointment channel and reviewer must be approved and available
  before this method is advertised or a result is released.
- **Representative:** verify the principal's entitlement and the representative's identity separately;
  verify the mandate's authenticity, requested scope and validity through its independently established
  source. Record why it permits this request and bind delivery to the verified recipient. Neither an
  unsigned attachment nor a forward is sufficient. The exact mandate-checking method requires approval.
- **Private evidence:** use a managed encrypted company volume, limited to the named owner/backup
  and authorized reviewer, with access logging and equivalently restricted backups. The supplied local
  CLI enforces OS ownership and file permissions; it does not establish encryption or approve a volume.
- **Retention:** proposed temporary scoped-response files expire 30 days after confirmed delivery.
  Review closed-case evidence at 90 days: erase data no longer needed for its documented purpose, or
  record the specific obligation/hold, reviewer and next review date. These are proposed internal periods,
  not statutory periods or implemented automatic deletion. The reviewer must reconcile them with owner
  retention and applicable duties before live use. No operator may retain data indefinitely by default.
- **Erasure handoff:** submit the verified authority artifact, exact scope, withdrawal receipt/outcome,
  responsible owner and private case reference to #1274. Require an erasure-owner result before reporting
  deletion; the ledger's `not-performed` value is never a deletion receipt.

[Decreto 1074/2015, Article 2.2.2.25.4.1](https://cancilleria.gov.co/sites/default/files/Normograma/docs/decreto_1074_2015_pr025.htm)
distinguishes sufficient Titular identity and accredited representation. Article 2.2.2.25.2.8 requires
purpose-limited retention and documented conservation/suppression procedures. The appointment,
proof-checking and retention choices above are Fidy proposals, not methods or durations prescribed
by that source. Review the applicable current regime and any bank-specific obligations separately.

## Completed mailbox transport rehearsal

With explicit operator authorization, the synthetic request was sent from `obarboza@fidyapp.com`
to the same address on 2026-10-14 at 11:21 America/Bogota. Its inbox arrival was observed before
replying in the same thread at 11:22. After reloading Gmail, both the received request and response
were present with their exact synthetic reference and bodies. Receipt is confirmed for this rehearsal.
Self-mail proves mailbox transport only: it does not establish requester identity, representative
authority, safe disclosure of customer data or the full operator acceptance criterion.

Request subject: `FIDY TEST #1273 — synthetic rights-channel rehearsal`

Request body:

> Prueba técnica con datos ficticios. Solicito confirmar la recepción de este mensaje de prueba
> por el canal publicado de Fidy. No solicito acceso a datos personales, retiro de autorización
> ni eliminación de datos de ningún cliente. Referencia: TEST-1273-MAILBOX-01.

Reply body:

> Recibimos el mensaje de prueba TEST-1273-MAILBOX-01 por el canal publicado de Fidy.
> Esta respuesta verifica únicamente el transporte del correo. No se consultaron datos de clientes,
> no se retiró ninguna autorización y no se realizó eliminación de datos.

Record confirmed delivery only after observing the reply in the intended inbox. A failed send or
uncertain receipt remains failed or uncertain; do not mark the rehearsal complete from a draft.
