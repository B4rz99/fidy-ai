# Titular requests — operator procedure for #1273

Status: implementation procedure, dated 2026-10-14. The product owner reported that legal
review of the procedure is approved and confirmed the withdrawal cutoff below. This records the
owner's confirmation; it is not an independent legal opinion or production acceptance evidence.
The owner of `obarboza@fidyapp.com` is the sole operator, with no backup. The local register is
working software; deployment and a full live operator rehearsal remain separate release evidence.

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

Receive every request without requiring login or payment. Receiving correspondence and releasing
personal data are separate steps. Record verification only after checking the existing proof,
same-person binding, scope and safe destination. Its private artifact identifies method, verifier,
time, conclusion and limitations; only its opaque reference enters `RecordVerification`.

- **User with access:** freshly authenticate through Fidy's existing provider or Browser Login
  mechanism. Supported privacy results are delivered to the same verified browser, including
  after withdrawal. A signup code or old sign-in does not establish fresh authority forever.
- **User who lost access:** use the existing [support-recovery procedure](support-recovery.md).
  It requires the live BrowserLoginPairing reference and the preissued BackupRecoveryCode through
  the designated recovery control. Never request cookies, PATs, browser-private verifiers or
  recovery secrets in email or the case ledger. Recovery does not renew Processing Consent.
- **All established proofs lost / Non-User Titular:** keep the rights request tracked, preserve
  deadlines and provide a non-disclosing acknowledgement. Existing recovery refuses when its
  required proofs are unavailable. No new assisted ID-document or selfie procedure is approved
  or implemented here. Email addresses, claimed financial facts and emailed documents do not
  authorize account access or disclosure. A separately established purpose-specific entitlement
  would be needed to release material outside Fidy's existing supported proofs; record that
  capability gap explicitly instead of treating the request as completed or rejecting intake.
- **Representative:** the representative's own login does not prove entitlement to another
  person's data. Record the need for established principal entitlement and a verified mandate
  covering the requested scope. Without those established proofs, track the case and give only
  non-disclosing notices. This implementation creates no representative disclosure authority.

Inability to recover ordinary login does not remove privacy rights. Neither case metadata nor
operator assertions create a WebSession or change User identity. Do not confirm whether another
person's User, records or credentials exist during verification.

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
are distinct. The product owner confirmed on 2026-10-14, with legal approval reported, that
specific work already durably queued or admitted before withdrawal may finish. No new
consent-dependent work is admitted after withdrawal commits, including new scheduled occurrences.
Only the exact same-User unfinished item retains its original bounded authority and expiry;
a transport payload, recurring schedule or retry cannot create or extend that permission.
Independent category revocation, recipient changes, credential restrictions, security limits,
expiry and one-shot provider claims still apply. Necessary privacy/security actions remain available.

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

## Operating decisions and release evidence

- **Owner:** the owner of `obarboza@fidyapp.com` is the sole operator; no backup is appointed or
  required by this implementation. Review pending cases each working day and act before targets
  expire. Track absence and overdue risk explicitly.
- **Approval:** the product owner reported legal approval of the procedure and explicitly confirmed
  the queued/running cutoff. Do not reopen that approval as an implementation blocker.
- **Verification:** use fresh Fidy authentication and the existing support-recovery proofs described
  above. No proposed assisted identity appointment, document check or new credential is introduced.
- **Private evidence:** use an encrypted company-controlled volume, outside Git, with access limited
  to the sole operator and explicitly authorized reviewers. Restrict backups equivalently. The local
  CLI enforces OS ownership and file permissions; it cannot prove that a particular operator volume
  is encrypted or configured. Keep the existing register/evidence mapping private.
- **Retention:** apply the approved purpose and retention procedure to real evidence; storage capacity
  is not a retention period. Temporary response copies and closed-case evidence need documented
  expiry or a specific hold with the next review date. No automated deletion is supplied by this CLI.
- **Unsupported requests:** keep unmet scope or entitlement visible, track its original deadline and
  communicate a non-disclosing status. Do not invent proof, infer access from email, or mark delivery
  complete without the verified scoped result and receipt.
- **Erasure:** retain the tracked #1274 handoff and its explicit withdrawal outcome. Report deletion
  only after the erasure owner supplies actual completion evidence.

The existing fresh-login/recovery methods prove product access. The rights procedure also needs
sufficient entitlement to the particular requested material and accredited representation, as
summarized in [Decreto 1074/2015, Article 2.2.2.25.4.1](https://cancilleria.gov.co/sites/default/files/Normograma/docs/decreto_1074_2015_pr025.htm).
This distinction does not introduce a Bancolombia OAuth requirement or a new ID-checking service.

Remaining release evidence is concrete: promote the reviewed browser/server/migration through the
normal production workflow, configure the actual private operator storage, and run a disposable
end-to-end case through the published channel, existing proof, supported scoped result and verified
response, including failed delivery and uncertain completion. Local integration tests and self-mail
are recorded below; they do not claim production release, a live claimant's completed request,
customer erasure, or closure of #1273.

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
