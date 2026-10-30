# Direct statement Workflow handoff, 2026-10-29

Statement dispatch can offer its committed outbox identity directly to the existing receiver,
avoiding Queue wait on the healthy path. The receiver still checks current ownership, retention
and submission state. An ambiguous Workflow creation requires a successful lookup of the same
submission id; unavailable creation and lookup fall back to the Queue. An unsuccessful offer
leaves the committed intent eligible for scheduled retry after its existing cooldown.

The hosted comparison used one private Worker, its own D1 and R2, the actual dispatcher and Core
Queue receiver, and real no-op child Workflows. The production recovery-generation wrapper was
active. Sparse Queue delivery retained batch size 10, zero batch wait and three retries. Both
variants used the current receiver; only the dispatcher's Workflow binding changed between
`None` and `Some`. Two warmup pairs preceded 24 counterbalanced measured pairs.

| Dispatch-start metric                | Queue path | Direct path | Improvement |
| ------------------------------------ | ---------: | ----------: | ----------: |
| Confirmed Workflow existence, median | 4,843.5 ms |  1,152.5 ms |       4.20× |
| Confirmed Workflow existence, p95    |   6,981 ms |    1,561 ms |       4.47× |
| Child execution starts, median       |   5,566 ms |  1,894.5 ms |       2.94× |
| Child execution starts, p95          |   7,953 ms |    2,628 ms |       3.03× |

The p95 uses nearest rank over 24 observations per variant. Every Queue receipt was attempt one.
All 48 children were complete when observed. The acknowledgement timestamp was captured before
the measurement receipt was persisted, so receipt persistence is outside the handoff interval.
Direct acceptance is the return from the same create/get receiver. Child start timestamps come
from each native Workflow's first execution. These cross-Worker wall-clock intervals assume
Cloudflare's clocks are aligned; no browser or operator API polling time is added to them.

This establishes neither extraction-completion latency nor total billing, CPU or memory gains.
The production five-minute discovery cadence is unchanged, and can dominate fresh submission
latency before dispatch. The healthy direct path removes Queue offers and consumer invocations;
it does not remove durable D1 intent or permit a handoff to stand in for extraction completion.

An earlier experiment measured dispatch to child completion and stopped at an undifferentiated
45-second Workflow deadline after eight measured pairs. It did not retain enough boundary state
to attribute that failure to producer execution, Queue delivery or child startup. Its raw outcomes
remain alongside the completed experiment; they are not silently discarded or treated as successful
latency samples. The revised experiment separately records confirmed handoff and observed child
start, and keeps an in-progress identity before polling.

See [raw results and harness sources](hosted-direct-statement-handoff-proof-2026-10-29.json)
and the [independent resource absence audit](generation-and-handoff-cleanup-2026-10-29.json).
The audit includes failed generation-control and handoff prototypes as well as successful runs.

The regression tests first failed because no direct Workflow creation occurred. They now cover
creation, existing-instance reconciliation, unavailable-create/get Queue fallback and expired
submission refusal. Existing tests retain Queue-only recovery, duplicate delivery and withdrawn
Consent behavior for durably queued work.
