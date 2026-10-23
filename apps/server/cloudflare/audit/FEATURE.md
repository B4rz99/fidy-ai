# Audit retention authority

Audit owns metadata-only operation evidence and ordinary call retention. Its published retention
runtime remains `src/shell/audit/runtime.ts`; native schema guards and purpose-specific erasure
projections live in this owner. Ordinary callers cannot rewrite or delete evidence.

## Ordinary cleanup (#1436)

`audit_retention_permits(user_id,cutoff_ms)` is a two-field exact-User permission used only inside
one native D1 batch: insert, assert one acquired row, delete up to 64 eligible Audit rows, delete the
permit. User owns no retention-control column. A failure anywhere restores both evidence and
permission state. A successful cleanup leaves no permit; a missing User or unexpected retained
permit refuses acquisition without deleting evidence. Retained anomalies require fenced
investigation, not an upsert or adoption of their cutoff.

Only `session_call`, `credential_call`, `insight_call` and `publication` use the original strict
365-day cutoff. The boundary row survives at equality. Global discovery remains bounded to eight
rows/subjects and selects the existing ordinary-retention index explicitly; User cleanup uses the
User-specific partial index. An ordinary permit cannot bypass an erasure fence or authorize another
User. Request admission retains its independent 93-day policy; Recovery retains its 24-calendar-month
terminal-case policy. Media, billing, identity/security, refresh and reminder evidence gain no new TTL.

The existing logical `audit_retention_permits` erasure projection retains its Audit purpose and User
lifecycle dependency. It now selects/deletes the owned table directly. Its insert/update/delete
fences and drain-time archive preservation remain purpose-specific; archived `{user_id,cutoff_ms}`
snapshots never become active permission. The obsolete User-field-clear trigger is removed.

## Native evidence

Existing Audit tests cover strict cutoffs, foreign ownership, append-only behavior, safe failures,
successful permit cleanup, rollback on final permit deletion, retained-permit refusal, erasure fencing,
bounded continuation and maintenance failure isolation. Mixed browser/PAT/hosted/publication coverage
retains attribution and deletes only the four ordinary kinds. Native erasure includes permits for
two Users and proves only the addressed User is removed.

The 65-expired-row journey, surrounded by 4000 current records for another User, completes in two
bounded units using at most 397 reads and 74 writes. An idle global sweep reads at most two rows and
writes none. Native query plans use the existing User/global retention indexes. Without selecting
the global expiry index, SQLite chose a plan reading 4005 rows for that idle sweep; the final query
avoids this scan. These are focused native database observations, not deployment measurements.

The [populated cutover](../../../../docs/operations/database-cutover-1428.md#audit-retention-permits-1436)
rejects any retained old User cutoff and unfinished erasure chunk, preserves User rowids and retained
fields, Audit sequences/contents, session relationships and archive references, and proves native
rollback after column removal. Other Audit extraction tickets retain their own migration obligations.
The fresh baseline remains one migration file; this slice is local and undeployed.

## Recovery case evidence

Recovery owns the immutable operator, terminal decision and timing on `support_recovery_cases`.
Approval commits that case with credential consumption and pairing approval; Audit no longer stores
`support_recovery` rows or their four dedicated columns. Other Audit variants retain their shape,
sequence ordering, retention and erasure permissions. Historical event IDs/archive references remain
bounded Case metadata under the original credential-erasure purpose. See the
[validated cutover](../../../../docs/operations/database-cutover-1428.md#recovery-case-evidence-1442).

## Final accountability log (#1476)

The nine retained kinds share occurred_at_ms; request admission now stores its exact acceptance
instant there instead of a second time column. Admission cleanup still uses its separate 93-day
inclusive boundary and partial expiry index. Ordinary call cleanup still covers only its four
approved kinds with a strict 365-day boundary. Credential-filtered queries, actor combinations,
billing transitions, media association and native mutation proofs remain unchanged.

Admission archives preserve their original accepted_at_ms key and sequence address through an
explicit projection. The populated native clock conversion/rollback covers all nine variants,
allocator high-water marks and archive preservation; it rejects count mismatch and interrupted
conversion atomically. Historical OAuth and reminder extraction rehearsals also preserve admission
time when targeting the final schema.
