# Recovery admission cost gate (#1434)

## Result

**Conversion blocked by the database-cost gate.** Retain the four-column
`support_recovery_admissions` table and Recovery's current admission implementation. No schema,
production caller, retained identity or accounting window changes in this slice.

[#1434](https://github.com/B4rz99/fidy-ai/issues/1434) requires comparing reads, writes and cleanup
against the compact original and blocking conversion when cost/equivalence fails. Parent
[#1405](https://github.com/B4rz99/fidy-ai/issues/1405) explicitly permits retaining the specialized
representation when shared grants/events cost more without a concrete code/behavior benefit.
The conditional shared-store mapping needs revisiting before a future conversion; this result does
not claim that the migration or the original table-reduction target has been completed.

The compact table already records one verified invocation with its exact operator issuer/subject
and admission instant. Each record participates in four rolling predicates: 5/operator/minute,
20/operator/hour, 20 globally/minute and 100 globally/hour. One-hour cleanup precedes admission;
admitted malformed bodies count, refused invocations do not. These are security controls, independent
of commercial tier and unrelated to ordinary app traffic. Recovery cases, current credentials,
Audit and their retention remain unchanged.

## Native comparison

Baseline: `a0bac8354738e656affff75e68f5df65d69d9adb`. Both implementations ran through the existing
`handleSupportRecovery` native integration fixture in
[the recovery tests](../../apps/server/cloudflare/recovery/support-recovery.test.ts), including
origin-verified assertions, real D1, concurrent requests and malformed admitted bodies. The candidate
passed all 18 existing behavior tests after adapting their physical-store observations; its measured
cost exceeded the compact budgets. It was removed after measurement. No candidate policy, index,
trigger, public interface or deployment remains installed.

The candidate used **one event plus one one-claim grant per invocation**, not four charges. A closed
operator scope encoded SHA-256 of the JSON tuple `[policy key, verified issuer, verified subject]` as
hex; User/session ownership remained NULL. Cleanup deleted only this policy's expired events, with
atomic orphan-grant cleanup. All four predicates still ran in the same batch before body decoding.
The existing active-scope index served operator lookups; a partial time index served global counts
and cleanup. Native grant-cardinality validation remained enabled. The counting predicates were
not eliminated or shared with an existing policy implementation: recovery still required all four
custom checks, plus scope construction, grant insertion and grant cleanup.

| Public scenario                                               | Compact reads / writes | Shared candidate reads / writes |
| ------------------------------------------------------------- | ---------------------- | ------------------------------- |
| Six concurrent malformed verified commands; five admitted     | 59 / 20                | 99 / 35                         |
| Same journey after one exact-minute refill; cumulative        | 73 / 24                | 123 / 42                        |
| Hour-boundary request, 1 ms before expiry; refused            | 23 / 0                 | 44 / 0                          |
| Hour-boundary request at equality; five expired, one admitted | 40 / 9                 | 86 / 17                         |
| Cleanup only, 1 ms before expiry                              | 1 / 0                  | 2 / 0                           |
| Cleanup only, five invocations at exact expiry                | 6 / 5                  | 31 / 10                         |

The concurrent shared journey also measured 95/35 and 121/42 in an earlier run; read work varies with
native execution/lookup ordering and generated identities. Writes consistently rose by 75% for
admitted invocations. The recorded comparison uses a complete subsequent run, not a claim that the
shared read count is invariant. Cleanup figures are the first batch statement's native D1 metadata;
request totals also include refusal/charge and conditional grant insertion.

The hour scenario admitted twenty invocations over four minutes, then one fresh invocation from a
different operator at 59m30s. At 59m59.999s none expires and the first operator remains refused.
At 60m exactly, only the original five expire and a new malformed request is admitted. Seventeen
records remain, including the other operator's fresh record. The retained test now checks both
sides of this boundary, exact compact query costs and foreign-operator preservation. No duplicate
inventory test or new test-only interface was added.

The shared candidate therefore adds storage, indexes and D1 work without removing the recovery
counting algorithm or changing useful behavior. Fewer tables alone does not pass this ticket's gate.
One compact independently retained event store remains justified. No backfill, source-table drop or
populated schema conversion is authorized by this failed gate, and no migration-readiness claim is
made. Existing data and the single schema baseline are untouched.

## Candidate SQL used for the comparison

These statements document the rejected measurement candidate, **not migration or deployment SQL**.
All values were bound; `scope` was the purpose-qualified operator digest, `id` a fresh invocation UUID,
`now` the owning Clock, `minute_cutoff = now - 60000`, and `hour_cutoff = now - 3600000`.
The installed baseline tables, indexes, guards and claim-cardinality trigger were retained.

```sql
CREATE INDEX resource_admission_recovery_time
ON resource_admission_events(admitted_at_epoch_ms)
WHERE policy_key='support.recovery.operator.v1';

CREATE TRIGGER resource_admission_recovery_grant_cleanup
AFTER DELETE ON resource_admission_events
WHEN OLD.policy_key='support.recovery.operator.v1'
 AND NOT EXISTS(SELECT 1 FROM resource_admission_events WHERE grant_id=OLD.grant_id)
BEGIN DELETE FROM resource_admission_grants WHERE id=OLD.grant_id; END;
```

One native transactional batch executed the following statements. The grant statement's result
classified allowed/refused; unavailable persistence remained fail-closed. A suppressed event could
not create a grant, and the grant-cardinality trigger still required its event.

```sql
DELETE FROM resource_admission_events WHERE rowid IN(
 SELECT rowid FROM resource_admission_events INDEXED BY resource_admission_recovery_time
 WHERE policy_key='support.recovery.operator.v1' AND admitted_at_epoch_ms<=:hour_cutoff);

INSERT INTO resource_admission_events
 (grant_id,policy_key,dimension,scope_key,policy_kind,units,admitted_at_epoch_ms,
  window_start_epoch_ms,expires_at_epoch_ms)
SELECT :id,'support.recovery.operator.v1','operation',:scope,'rolling_window',1,:now,
 max(0,:hour_cutoff),:now+3600000
WHERE (SELECT count(*) FROM resource_admission_events
 WHERE policy_key='support.recovery.operator.v1' AND dimension='operation' AND scope_key=:scope
 AND admitted_at_epoch_ms>:minute_cutoff)<5
AND (SELECT count(*) FROM resource_admission_events
 WHERE policy_key='support.recovery.operator.v1' AND dimension='operation' AND scope_key=:scope)<20
AND (SELECT count(*) FROM resource_admission_events INDEXED BY resource_admission_recovery_time
 WHERE policy_key='support.recovery.operator.v1' AND admitted_at_epoch_ms>:minute_cutoff)<20
AND (SELECT count(*) FROM resource_admission_events INDEXED BY resource_admission_recovery_time
 WHERE policy_key='support.recovery.operator.v1')<100;

INSERT INTO resource_admission_grants(id,admitted_at_epoch_ms,claim_count)
SELECT :id,:now,1 WHERE changes()=1;
```

Reproduce the retained compact behavior/cost checks locally with:

```sh
bun run --cwd apps/server test:cloudflare -- cloudflare/recovery/support-recovery.test.ts
```

The shared comparison was a fenced local experiment on the baseline above; the SQL records its
counting/index/cleanup shape for reevaluation. No benchmark requires a Cloudflare account or writes
to a remote database. A different representation must pass the same public behavior and native cost
gates before replacing the compact store; deleting its index, skipping grant validation, reusing an
invocation's charge or switching to fixed windows is not an equivalent optimization.
