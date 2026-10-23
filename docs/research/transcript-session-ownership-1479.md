# Transcript session ownership cost gate — #1479

Decision: retain `transcript_entries.hosted_session_id` and its session/sequence index. Add the
missing equality check to its immutable parent Turn. This is the accepted fallback in #1416/#1479;
it does not introduce another transcript store or change retention, compaction, or public outputs.

## Native experiment

```sh
INFRA_PERFORMANCE_MEASURE=1 bun run --cwd apps/server test:cloudflare -- cloudflare/agent/hosted-retention.test.ts -t 'measures native session ownership'
```

The existing native retention seam seeds 1,500 terminal Turns and 3,000 retained entries across 15
sessions for one User. This corresponds to 30 days at the existing 50-Turn Pro daily budget; the
selected session has the supported maximum of 200 entries. The synthetic historical seed bypasses
only initial Turn/Consent admission triggers while loading terminal history, then restores them.
It is a query-cost fixture, not evidence that these Turns went through live admission. A second
User/session exists in the existing setup; other public tests cover isolation and exact evidence.

A candidate copy removes the stored session field and its direct session foreign key, retaining
entry identities, global sequences, typed column shape and per-Turn indexes. The comparison gives
it an additional covering parent index on (user_id,hosted_session_id,id,status), and forces the
existing pending-Turn partial index for its pending-prefix check. The extra index's write/storage
cost is not charged to the candidate. Three alternating-order samples compare exact query outputs,
D1 rows read/written and native query plans. Results and plans are in
[transcript-session-measurements.json](transcript-session-measurements.json).

| Query phase                               | Explicit reference: rows read | Derived reference: rows read |
| ----------------------------------------- | ----------------------------: | ---------------------------: |
| Session's ordered entries and Turn status |                           401 |                          601 |
| Exact prefix count                        |                           201 |                          401 |
| No-Pending prefix check                   |                             0 |                            0 |
| Ordered incorporated-prefix selection     |                           201 |                          601 |
| Bounded retention deletion selection      |                           399 |                          399 |

Rows-read counts repeat across all samples. The derived session read requires a temporary ordering
B-tree and 50% more reads. Prefix counting doubles reads; ordered prefix selection nearly triples
them. Retention selection already follows the parent Turn and stays equal. Local millisecond
latencies are small and noisy; they do not establish production latency or pricing. The gate fails
on repeatable native read amplification, even with the candidate's extra covering index.

These are the actual read shapes used for session continuity, compaction prefix validation and
bounded cleanup selection, not a benchmark of the complete mutation/cleanup engine. Writes,
authorization, assertion slots, retention-trigger costs and Workflow/provider overhead are outside
this read-only experiment. The extra reads already occur before any candidate deletion; omitting
its additional mutation work makes the evidence an optimistic comparison for field removal. No
claim is made that selecting deletion candidates measures actual deletion cost.

## Storage decision and consistency

Keep the explicit reference as an indexed projection. `transcript_parent_session` requires the exact
same-User parent Turn to name that session before each append. The existing append-only Transcript
and immutable Turn ownership prevent later divergence. This avoids adding another parent index or
hiding the reference inside JSON. No public operation needs a second storage path.

The cutover validates the full historical User/Turn/session relationship before creating the
trigger, stopping on mismatches rather than changing conversation ownership. Native populated
checks preserve every entry field, sequence and allocator high-water mark through installation and
rollback; count mismatch, inconsistent history and an interrupted batch are rejected. Existing
hosted continuity/tool/retention tests retain exact text, terminal markers, safe tool evidence,
visible-delivery completion, failed compaction rollback and erasure semantics.
