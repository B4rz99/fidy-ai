# Whole-Titular erasure — #1274

Implementation, operator procedure and verification evidence. The Production bootstrap and release
proof below do not establish execution of a real erasure case or processor deletion. This extends the approved [#1273 procedure](titular-requests-1273.md).
`obarboza@fidyapp.com` remains the sole operator. There is no backup operator and no new document,
selfie or emailed-ID verification. Exceptional entitlement remains #1326.

## Verified request and review

1. Receive the request through the existing free rights channel. Preserve its actual received time,
   scope and identity evidence in the restricted #1273 register/evidence locations. Use existing Fidy
   proofs and the approved procedure; receiving an email or knowing a User UUID proves nothing.
2. The User confirms **Eliminar tus datos** on `/settings/privacy` with a fresh cookie-only Fidy
   sign-in. That creates one durable `AwaitingReview` intention for that exact authenticated User.
   It does not erase data, renew Consent or replace the free support channel. A retry reuses the same
   intention. People unable to supply an existing proof follow #1326; do not guess their User.
3. Bind the verified local case to that exact intention and User in restricted evidence. Review the
   scope, permissible action, each actual processor, the final response destination and all holds.
   Record `ReferErasure` in the existing register. Preserve its actual withdrawal handoff:
   `Recorded` needs the existing withdrawal reference; `NotRequested`, `Pending` and `Unavailable`
   must not be silently converted into a withdrawal. A processing withdrawal and an erasure decision
   remain distinct authorities.
4. Build a private `ErasureDecision` using
   `apps/server/src/core/erasure/contract.ts`. `reference` is the server intention, `caseRef` the local
   case, `authorityRef` its verified authority, `scopeRef` its reviewed scope, `handoffRef` the actual
   referral, and `reviewRef` the recorded disposition review. `responseRouteRef` addresses evidence
   of the agreed, verified destination usable after login ends; it is not a mailbox address or URL.
   The record supports current-MVP whole-User scope only. Do not submit a broader scope than approved.
5. In the private operator terminal, run
   `bun run titular:erasure:prepare /absolute/private/register < reviewed-decision.json > review-command.json`.
   Set `umask 077` first; keep these files outside Git, in the approved encrypted evidence location.
   This reads the actual register and refuses mismatched case, authority, handoff, scope, requester
   class or withdrawal. It only prepares a command. It does not authenticate the claimant, contact a
   provider, acquire server access or perform deletion. Do not bypass a refusal by editing the ledger.
6. Send that reviewed command to `POST https://api.fidyapp.com/internal/titular-erasure` through the
   separately configured **TitularErasureAccess** Cloudflare Access application. Its audience is
   distinct from recovery and billing. Only the existing operator email is admitted; assertions use
   issuer signing keys, RS256 and a maximum fifteen-minute lifetime. Service-token assertions,
   browser Origin, query parameters and extra command fields are refused. Never put the assertion
   in a checked-in script, URL, evidence JSON or shared transcript.

The server rechecks the intention's exact User/reference under the existing User coordinator before
approval. A guessed reference, mismatched User or caller-selected deletion table cannot initiate
work. Identical reviewed decisions replay; changing an already approved scope is refused. Ordinary
append-only and cross-User restrictions remain in force.

## Executable scope and cutoff

The [inventory](titular-erasure-inventory-1274.md) names all owner publications and exclusions.
Every class has an explicit `Delete` or reviewed `Retain`. Credential/identity records always delete;
held evidence cannot restore credentials. Each hold needs an actual source, reviewed scope, limited
purpose, expiry, review date and terminal deletion. UUID references are pointers to that restricted
review, never legal justification by themselves. There are **no default legal retention periods**.
Do not copy the short or forty-day durations used in synthetic tests into a real case.

Approval establishes `Draining`: new protected admissions stop. Exact work durably admitted before
that cutoff may finish only within its original identity, category, credential and lifetime bounds.
Review any pending owners and provider ambiguity; elapsed application time does not prove delivery.
Scheduled work must already have its native occurrence/outbox admission. No new recurrence is
admitted. An enabled Connection with unresolved suppression blocks sealing and is reported as
`connection-suppression`; #313 owns the bank-specific suppression implementation.

The coordinator seals only after owner quiescence and live original-byte reservations settle. It
retires MCP owners, confirms their drain and removes/checks the native alarm. Native D1 fences then
refuse recreation, including moving an existing row away from the erased User. Ephemeral deletion
permits are exact User/store and exist only inside one native D1 batch. Ordinary projection triggers
are suppressed solely for their exact authorized source erasure, because their derived stores have
independent dispositions; ordinary cleanup still updates the shared review-capacity counter.

A reviewed hold survives routine row cleanup during draining: a native same-User delete guard
preserves the approved credential-free record in the restricted erasure archive first. All retained
D1 records and originals are copied to the private erasure bucket before source disposition. No
product view or normal credential can read this bucket or these archives.

## Continuation, failure and receipt

Use the operator endpoint with `{ "action": "Continue", "userId": "…", "reference": "…" }`.
Each call performs at most two bounded owner chunks (64 D1 rows per chunk), or one bounded phase
step; source objects, private copies and recovery manifests have separate small page limits. The
minute maintenance activity also resumes a bounded set of due approved cases. There is no claim of
one transaction spanning D1, R2, Durable Objects or processors.

After lost acknowledgements, timeouts, partial R2 success or worker restart, repeat the same
reference and decision. Do not create a second case or replay a payment/provider request as a
cleanup shortcut. A missing original or a failed retained copy blocks its disposition rather than
inventing a successful copy. Original payload writes use a private placeholder ETag and a live owner
reservation; deletion changes that ETag before removing the object, so a delayed payload cannot
recreate the financial bytes. Ambiguous control-object cleanup remains pending for reconciliation. A metadata-only maintenance
sweep separately reconciles expired placeholders and erased nonces, including late orphan control
writes after an owner row has gone. It never deletes financial payloads or held records by that
control-only path. The scan is bounded and durable; eligibility at expiry is not a promise that a
large backlog physically clears at the exact expiry instant.

`{ "action": "Receipt", "userId": "…", "reference": "…" }` uses operator Access, not the erased
User's cookie, PAT or Consent. It reports completed classes, actual restricted retained copies,
pending processor work, reviewed control retention, backup window and next action. R2 residual
copies prevent a false completed-class claim even if their D1 checkpoint was lost. Send the human
response only over the verified route addressed by `responseRouteRef`, record delivery in #1273,
and distinguish confirmed, failed and uncertain delivery. A server receipt does not send email.

Review dates and finite approved deadlines require operator action. Do not invent a new retention
basis or silently extend a deadline while an external request is unresolved. Review ongoing
obligations before expiry and escalate a source/capability conflict explicitly. Source records and
private copies expire through bounded cleanup; expired holds are never copied anew. Each later
physical deletion resets Cloudflare verification and its recovery clock. Completed case controls
purge only after both reviewed control deadlines and the last personal-data backup window; recovery
locators and the case marker purge before their D1 control rows. Incomplete cases are never silently
closed by the completed-case sweeper. An overdue control review is returned as `retention-review`,
even when local erasure is finished; neither the provider obligation nor its expired justification
is represented as resolved.

For an actual, newly source-backed decision about keeping the restricted case controls, send
`ReviewRetention` through the same dedicated operator Access application:

```json
{
  "action": "ReviewRetention",
  "userId": "<exact reviewed User UUID>",
  "reference": "<exact erasure UUID>",
  "previousReviewRef": "<current receipt-retention review UUID>",
  "receiptRetention": {
    "sourceRef": "<source UUID>",
    "reviewRef": "<new review UUID>",
    "purpose": "rights-response",
    "untilMs": 0,
    "reviewAtMs": 0,
    "terminal": "delete"
  },
  "recoveryRetention": {
    "sourceRef": "<source UUID>",
    "reviewRef": "<new review UUID>",
    "purpose": "restore-enforcement",
    "untilMs": 0,
    "reviewAtMs": 0,
    "terminal": "delete"
  }
}
```

Replace the zeroes with reviewed finite future times. Record the actual justification and operator
review in restricted evidence under those new references; moving dates alone is not justification.
The command applies only to unfinished cases; completed cases follow terminal cleanup and cannot
accept a new retention amendment. It refuses stale authority, a different User, a reused review, shortening approved
retention or a deadline inside the actual last-deletion backup window. It changes only the two
case-control retentions. Financial holds, scope, withdrawal, provider outcomes and the configured
backup window remain the original reviewed decision. The independent registry receives the review
before the native generation advances; rollback replay uses the latest control review. An interrupted
commit can require the existing restore procedure. There is no automatic renewal. Unreviewed overdue
controls remain an explicit operator action; resolve the actual source conflict and provider request.
Once the case is complete, the existing bounded cleanup deletes controls after both revised deadlines
and the last financial-data backup window. Do not erase an unresolved case merely to hide its status.

## Actual processors and manual disposition

The operator must examine the case's actual disclosures. Do not send full User exports or credentials
just to open a deletion request. Use the processor's authorized account channel and exact provider
subject/message/payment identifiers from restricted evidence, for the minimum reviewed scope.
Check its current account capabilities and contractual terms at execution time; this implementation
contains no invented provider deletion API or paid-plan upgrade.

| Custodian    | Controlled action and evidence                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare   | Complete native Fidy dispositions and review D1 Time Travel, R2/provider backup and Durable Object residuals with the account's real capabilities. Application deletion/strong consistency alone does not prove physical backup erasure.                                                                                                                                                                                           |
| Kapso        | Use the authorized Kapso account/support route for the affected WhatsApp history. The accepted **Free-plan indefinite history** MVP decision is unchanged. Record actual acceptance, capability and result. If a valid request conflicts with that retention or deletion is unavailable, keep the affected scope `Unresolved` and escalate the specific decision. Do not upgrade automatically or invent a finite provider expiry. |
| Meta         | Review actual WhatsApp Business/Cloud API processing, minimum message/subject scope and applicable Meta rights/support channel; verify its actual result independently of Kapso.                                                                                                                                                                                                                                                   |
| Resend       | Review actual delivered authentication/onboarding/notice emails and associated recipient/message history; request the permitted deletion via the authorized account/support path and record residual contractual retention.                                                                                                                                                                                                        |
| Wompi        | Review actual customer/payment-source/attempt disclosure. Ask the authorized merchant/support channel for the permissible erasure or statutory-retention disposition. Fidy metadata deletion is not cancellation, refund or proof Wompi erased financial records.                                                                                                                                                                  |
| SupportInbox | Dispose of request correspondence and delivered attachments in the actual mailbox under the reviewed scope and retention. Verify the inbox/trash/archive treatment, including its provider retention.                                                                                                                                                                                                                              |
| CaseRegister | Apply the approved retention procedure to the actual restricted local case record and its backups; the server does not operate the local register.                                                                                                                                                                                                                                                                                 |
| CaseEvidence | Dispose of the actual restricted identity, review, response and delivery evidence under its approved sources/deadlines, including local volume/backups.                                                                                                                                                                                                                                                                            |

Submit `CustodyEvidence` with the exact User, request reference, custodian and fresh `evidenceRef`.
The `outcome` is `Accepted`, `Verified`, `NotApplicable`, `Retained` with its reviewed retention,
or `Unresolved` with `capability-unverified`, `retention-conflict` or `request-declined`.
Evidence references address the actual restricted request/response, not an operator assertion without
support. `Accepted` is never completed deletion. Cloudflare, CaseRegister and CaseEvidence cannot be
marked not applicable. `Verified` for Cloudflare is refused until the last deletion's selected D1
window expires; a pre-deletion verification event cannot be replayed to verify a later purge.

An `ExternalPending` case stays visible until all native stores/holds and actual custodians resolve.
A pending processor, incompatible Kapso capability, retained external scope or unresolved bank
suppression never produces `Complete`. Deliver an accurate interim rights response rather than
waiting silently or claiming completion.

## Recovery procedure

D1 Time Travel is always on: **Free seven days; Paid thirty days**. The reviewer records the actual
account tier in `recovery.sourceRef`, its review and `windowMs`; deployment does not assume a tier.
Restore overwrites D1 and may cancel in-flight queries. See
[Cloudflare Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).
[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) concerns application
put/delete/head visibility, not proof of physical provider-backup destruction.

Reviewed decisions, original locators, retained record copies and a recovery generation checkpoint
live outside the restored D1, in the independent private erasure bucket. Every normal native data
unit, including D1 Sessions, atomically asserts the external generation against D1. Missing required
registry configuration or a mismatch refuses normal data reads and writes across entrypoints.

For the first feature release, keep the new guarded candidate isolated from ordinary traffic while
applying migrations and wiring both private registry bindings. The normal Production workflow
stages it at zero percent beside the previously working release. Before the first erasure approval, the designated operator sends
`{ "action": "Initialize" }` through the dedicated Access application. This one-time bootstrap
requires an initial native generation, no approved case and an empty registry (or an identical
initial checkpoint). Ordinary reads never create a missing checkpoint. After any approved case,
initialization refuses; a lost registry must be recovered independently rather than reinitialized.
Local development performs the equivalent empty-registry check as an explicit Alchemy startup action
before binding the required guard to its workers. This is confined to the local stack; it refuses
missing checkpoints for approved cases. Production bootstrap continues to require operator Access.
Initialize must reach that exact staged ingress/Core pair before the full smoke gate: the previous
release does not implement the new operator endpoint. Use the current deployment's candidate
version IDs in `Cloudflare-Workers-Version-Overrides` on the native POST, alongside the dedicated
human Access assertion obtained with:

```sh
cloudflared access login --quiet https://api.fidyapp.com/internal/titular-erasure
```

Prepare the operator call before starting the
workflow; candidate routing is temporary and failed smoke cleanup removes it. Ingress preserves this
routing metadata only on the operator POST carrying an assertion; Core still verifies signature,
issuer, distinct audience, exact operator, human identity and bounded lifetime. A routing header
or unverified assertion grants no data authority. Never print or put the assertion in a URL,
command argument, checked-in file or CI log; use a protected temporary file or credential store and
an HTTP client that reads it without following redirects. Remove temporary credential files afterward.
Do not bootstrap by writing the bucket or D1 directly. Recheck that the independent checkpoint and
native initial generation agree, then let both exact-pair and normal-traffic smoke gates pass.

Confirm ordinary guarded access before releasing traffic. This operator step is required release
work, not evidence that this checkout has been deployed.

On 16-10-2026 UTC, releases `0bd4d7d668` and `db0e731ad9` stopped before promotion at smoke
admission. Read-only control-plane checks found native generation `initial`, no approved erasure
case, and no `recovery/generation` object in the newly provisioned private bucket. The guard was
correctly refusing uninitialized access. A separate ingress regression exposed why the operator
could not bootstrap the candidate: its routing override was stripped before the private Core.
The native journey now checks initialization through ingress and still refuses wrong account/audience,
machine, expired, overlong and forged assertions before continuing the owned restore exercise. The routing fix was merged in [PR #1351](https://github.com/B4rz99/fidy-ai/pull/1351)
as `0f2df68a9233094e40223fab15d167b671cced24`. At 12:17:38 UTC on 16-10-2026, the dedicated
human operator Initialize returned 204 with `no-store` through that exact zero-traffic ingress/Core
pair. A subsequent independent read found `recovery/generation` equal to `initial`. No direct bucket
or D1 bootstrap write was used, and the temporary assertion copy was removed. This establishes the
one-time initialization, not execution of an erasure case or provider deletion.

[Production run 38899280216](https://github.com/B4rz99/fidy-ai/actions/runs/38899280216) then
passed both candidate/intermediate pairings, promoted the exact tested versions and passed the normal
traffic probe. Public health reported `available`, revision
`0f2df68a9233094e40223fab15d167b671cced24` and contract digest
`44612b70c28a1d5456d7319ed3563a62176294f0fd59efc5ffc9d55ec67bd403`. This verifies guarded
admission after initialization; it is not a live restore or erasure rehearsal.

Before any restore, keep public traffic blocked and preserve the independent erasure bucket. Restore
D1, then apply the current migrations using the normal infrastructure release procedure before
running application code. Never restore or empty the erasure registry together with an older D1
snapshot. If the registry is unavailable, keep data access blocked; do not edit generation values to
force availability.

Use operator `{ "action": "Restore" }` repeatedly until `AwaitingDisposition`. This scans small
pages of independently saved reviewed cases, reconstructs exact-User dispositions and imports
original locators and still-live restricted holds. Resume each exact case through `Continue` or
scheduled maintenance. A record/registry conflict refuses recovery rather than silently discarding
an erased User. A separate `sealed` proof in the independent registry records that admitted work
was drained and the coordinator cleared before deletion began. A rollback with that proof can seal
stale pending rows again; an unsealed case must drain its original admitted work first and cannot
claim completion merely because recovery was invoked. If those owners cannot settle while traffic
is fenced, keep recovery blocked and reconcile the interrupted original work before release.
Reapplying the same generation is idempotent. Use `{ "action": "ReleaseRestore" }`
only after reconstruction: it refuses release until the scan is complete and every reconstructed
case has finished its native D1/R2 dispositions. Processor work may still remain accurately pending.
The ordinary generation fence remains closed until this native check succeeds. Restored credentials
then refer to no erased User, while foreign-User data remains usable.

## Local verification

- Native Miniflare D1/R2 and the actual SQLite-backed User Durable Object, two disposable Users,
  every personal-data class, derived projections, original bytes and a full worker restart.
- An older independently seeded native D1 snapshot with the same Users/credentials, preserved R2
  erasure registry and actual worker reconstruction. Access is refused before replay/release; target
  rows and credentials are re-erased and foreign rows survive. This models rollback locally; it is
  **not a live Cloudflare Time Travel rehearsal**.
- Native R2 retained-copy success followed by an injected real D1 trigger failure, retry and expiry;
  held D1 records survive draining cleanup and rollback, then both native/private copies expire.
- Exact-User references, native immutable evidence guards, OLD/NEW ownership-move refusal and no
  leaked deletion permit. Operator tokens with wrong email/audience, expiry, overlong lifetime,
  machine identity, forged signature or extra command fields refuse.
- Production-built browser, real local public ingress/Core/D1: explicit intention, fresh authority,
  idempotent retry and no false deletion claim. No customer data or processor history was erased.

Focused reruns:

```sh
bun run --cwd apps/server test:cloudflare cloudflare/erasure
bun run --cwd apps/web test:browser privacy.spec.ts --workers=1
bun --bun vitest run --config scripts/vitest.config.ts scripts/titular-erasure/operations.test.ts scripts/titular-requests/runtime.test.ts
```
