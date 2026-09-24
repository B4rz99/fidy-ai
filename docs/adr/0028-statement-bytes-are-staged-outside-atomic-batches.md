# Statement bytes are staged outside the atomic-batch contract

- **Status:** Accepted
- **Date:** 2026-09-24

`ingestion.submitForExtraction` remains the only canonical operation that creates statement
authority, and it stays a derived atomic-batch child with no eligibility exemption. Its bounded input
cites staged material by `StagedStatementReference` — identity, actual byte length, and actual
SHA-256 digest — instead of carrying bytes. Raw bytes reach private R2 through a bounded,
User-authenticated staging transport that is not a canonical operation, is not an agent or MCP tool,
returns only the non-authoritative reference, and grants no scope, no readable content, and no
authority. That transport is the second narrow stable-User exception in root `ARCHITECTURE.md` §2,
recorded here rather than introduced silently; the first is the proof-bearing credential bootstrap
with no stable User.

R2 staging and D1 publication never share a transaction. R2 writes are strongly consistent per
object, and a D1 `batch()` is one SQL transaction; they are separate authorities with no distributed
unit between them. The protocol therefore orders durable state so that no authoritative submission
can refer to missing or mismatched bytes:

1. the body is read with an actual-byte bound and digested;
2. a non-authoritative `pending` staging row records identity, actual size, digest, and expiry;
3. the object is written with R2's own SHA-256 checksum verification;
4. the row becomes `available`; only then can a caller hold a reference;
5. publication re-verifies ownership, availability, expiry, reference size/digest, and the stored
   object's size and checksum before one conditional D1 unit inserts the submission, promotes the
   staging row only when that insert committed, and records metadata-only audit success.

Failure, interruption, or abandonment leaves at most an unpublished staging row and object; the
canonical mutation is never reached. A bounded sweep moves expired unpublished rows to `deleting` in
one D1 statement, deletes their objects, and then removes the rows; D1 serializes that transition
against publication, so publication can never commit against material the sweep has reclaimed, and
an interrupted sweep resumes from the durable `deleting` state, so no object is left unreachable and
no bucket lifecycle rule is needed for correctness. Published material is excluded from the sweep and
is owned by the submission's own retention.

## The comparison that selected this contract

| axis                          | byte-bearing canonical input                                                                                                                                                                                                   | staged reference                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| atomic-batch request bounds   | twelve maximum statements are 12 × 6,990,508 base64 characters ≈ 80 MiB of JSON, against Cloudflare's 100 MB request-body ceiling (Free/Pro) and 128 MB isolate memory, before `JSON.parse`, base64 decoding, or a 5 MiB parse | twelve references are a few hundred bytes each                                                                                          |
| streaming                     | impossible: a JSON body is decoded whole, and the schema's JSON codec for raw bytes is base64 anyway                                                                                                                           | bytes stream once against an actual-byte bound, then are never re-encoded                                                               |
| canonical-operation ownership | one canonical operation owns bytes, but "batchable" is nominal: any real multi-statement batch exceeds safe request and memory bounds                                                                                          | the canonical mutation owns publication; byte transport is a named, non-authoritative ingestion transport outside the operation surface |
| retention                     | nothing is retained, so a failed or interrupted request loses the upload and no cleanup exists                                                                                                                                 | staging is bounded and expiring; publication promotes material into the submission's retention                                          |

The byte-bearing alternative cannot satisfy both the aggregate batch bound and streaming, so the
staged reference is selected. Keeping bytes in the canonical input would also mean statement
submissions could only be batch children alone or beside tiny siblings, which is the exemption from
batching this decision rejects.

Canonical mutations must be transaction-composable, and the derived batch child union is built from
each mutation's JSON-encoded input. A streamed raw body cannot be a JSON batch child, and making byte
transport a standalone canonical mutation is the one-time account-security exemption ADR 0027
reserves and explicitly refuses to widen. Byte transport therefore cannot be a canonical mutation at
all; ownership of authority stays with `ingestion.submitForExtraction`.

## Consequences

- #698 lands the staged-reference input, the authenticated staging transport with its admission and
  limits, the private Core Worker R2 binding and scheduled sweep, and D1 retention context and outbox
  identity for the published submission. It must keep passwords, statement content, filenames, and
  digests out of Audit, errors, and telemetry. The staging adapter installs no telemetry sink and its
  refusals carry only a closed reason, so content can reach neither Audit nor telemetry by
  construction.
- #790 composes publication with other canonical mutations under one User coordination turn. R2
  staging remains non-authoritative until that D1 publication; a cross-User staged reference is
  refused without revealing whether it exists; a batch cannot stage or publish several files to
  multiply admission.
- The private Core Worker gains one private R2 bucket in the Alchemy stack. No bucket lifecycle rule
  is needed for correctness: the sweep's durable `deleting` state is the cleanup authority. The
  ingress never receives an R2 binding, and no staging object is served back as active content.
- `apps/server/cloudflare/ingestion/statement-staging.ts` and its local D1/R2 proof are the
  executable evidence: actual-byte and digest bounds, interruption and replay, opaque User-owned
  identity, cross-User refusal, missing or substituted object refusal, metadata-only audit, bounded
  expiry/cleanup, and a losing reference that shares an idempotency key with a committed winner.

## Rejected alternatives

- **Byte-bearing canonical input.** Fails aggregate batch bounds and streaming, loses interrupted
  uploads, and has no retention or cleanup path.
- **A standalone canonical staging mutation.** ADR 0027 permits that exception only for one-time
  account-security mutations; implementation convenience is not a reason.
- **An unrecorded stable-User upload route, or one that returns uploaded content to the caller or
  grants scope.** The exception exists only because it is named, bounded, non-authoritative, and
  expires.
- **Publishing first and verifying later, or assuming R2 and D1 commit together.** Either can leave
  an authoritative submission pointing at missing or mismatched material.
