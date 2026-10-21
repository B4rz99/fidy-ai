# Resource Admission

Accepted design: [#1405](https://github.com/B4rz99/fidy-ai/issues/1405).
Admission protects infrastructure and provider capacity; it does not implement commercial allowances.
Installed Worker policy owns limits, dimensions and windows. Callers select an installed policy key
and scope, never an arbitrary public policy.

## Commit ownership

`prepareResourceAdmission` prepares a complete grant without spending capacity. The owning feature
includes all prepared statements in its D1 batch with its proof, state and outbox writes. The grant's
required claim cardinality is still enforced by D1; refusal rolls back the owner's writes as well.
Preparation is not an admission receipt. Only successful settlement permits external work.

The owner must use the configured binding, preserve preparation order and wait for its native batch
to settle on interruption. `classifyResourceAdmissionFailure` distinguishes native admission-trigger
refusal from unavailable persistence without publishing raw SQL errors. Consent's disclosure exchange
is the first owner-controlled commit using this interface.

`admitResource` retains the complete-commit interface for standalone callers. Attempt pressure remains
a distinct, deliberately committed charge before work admission: a refused work claim does not undo
its attempt charge. Outstanding release still commits with the owner's completion statements.

## Counter and ownership contracts

`ResourceAdmissionCounterTransition` admits only the accepted email pairing User/global,
email replacement, anonymous PAT pairing-source and hosted compaction variants. Email and PAT source
windows are anchored to their first accepted request; reset occurs at start <= cutoff. Compaction
uses UTC calendar days and retains separate historical days. Replacement alone carries its original
work binding. Each owner retains proof, eligibility, refusal and charging-point decisions.

`ResourceAdmissionEventOwner` distinguishes a stable User from a same-User WebSession. Global and
anonymous scopes do not acquire fabricated ownership. Source identity remains its original keyed
32-byte digest. Opaque scope keys are not authorization.

These are the preparatory contracts for #1432–#1435, not migrated consumers. Those slices install the
counter store and explicit event ownership together with their production callers, erasure adapters,
constraints and populated conversion. #1431 changes no persisted representation and needs no database
cutover. Do not create an empty target table or remove an old store in advance of its owning slice.

## Equivalence and cost gates

The existing native Resource Admission integration seam verifies exact rolling/calendar boundaries,
concurrent admission, complete grant cardinality, rollback, release, interruption and restart. The
owner-controlled one-charge/outbox commit has a ceiling of eight D1 row writes, including indexes;
preparation adds no SQL query or preliminary commit. Consent's signed webhook integration covers the
production composition and refusal without disclosure/provider effects.

Measure native `D1Result.meta.rows_read` and `rows_written` at the existing owner integration seams
before and after each consumer conversion. Include the last accepted request, first refusal, exact
reset, concurrent contenders and bounded retention; compare equal retained history and active scope.

| Consumer                          | Existing seam                       | Required comparison                                                                        |
| --------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| Email pairing/replacement (#1432) | Onboarding browser authentication   | Anchored User/global windows, original replacement binding, rejected proof rollback        |
| PAT pairing/review (#1433)        | PAT pairing native integration      | Keyed source window, atomic global pending check, exact session rolling events and erasure |
| Support recovery (#1434)          | Support recovery native integration | One invocation contributes to four rolling predicates, including malformed admitted bodies |
| Hosted compaction (#1435)         | Hosted continuity/retention         | Three admitted UTC-day attempts, abandoned work remains charged, retained older days       |

A smaller table count does not waive the cost gate. In particular, do not replace one recovery event
with four generic writes unless measurements demonstrate a concrete code/behavior benefit. Keep a
specialized representation and revisit the target if the shared representation fails that gate.
