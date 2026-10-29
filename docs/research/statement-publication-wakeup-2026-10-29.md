# Statement publication wake-up, 2026-10-29

Committed queued or processing statement readback now supplies a best-effort wake to the owning
User coordinator. The durable alarm discovers only that User's published intents and invokes the
existing direct Workflow / Queue fallback handoff. The five-minute cron remains recovery for a
missed wake. No pre-commit notification, new browser upload route, grant, or extraction authority
is introduced.

A resident scheduler coalesces at the earliest deadline, including existing hosted Turn recovery.
The alarm attempts statement and hosted recovery even if one fails; hosted recovery re-establishes
its future deadline. Erasure retires the scheduler before joining native writes and clearing the
alarm, fencing queued and late callbacks. Alarm failures do not undo an already durable submission.

## Hosted comparison

Four phase-matched pairs used one private Worker, real named SQLite Durable Objects, the actual
User coordinator alarm handler, synthetic D1/R2, the production recovery-generation wrapper,
and real no-op child Workflows. The same ingestion owner committed each intent before the fixture
read it back. The fixture supplies the native wake scheduler to held-owner readback; it does not
exercise the complete WhatsApp Turn service or a public upload endpoint.

The control disables the wake and waits for the next five-minute boundary, represented by a
native Workflow timer calling the current global dispatcher. This reproduces the discovery policy,
not Cron Trigger transport. Two synthetic Users have valid seven-day Trial periods; limits and
admission are unchanged. ABBA order alternates the two variants across four pairs.

| Readback start to native child start |    Control |       Wake |
| ------------------------------------ | ---------: | ---------: |
| Median                               | 200,677 ms | 5,155.5 ms |
| Maximum observed                     | 251,206 ms |   6,643 ms |

The median improvement in this phase is **38.92×**. There are only four samples per variant;
no p95, throughput, multi-region, production API, CPU, memory, invoice, or actual extraction
completion gain follows from this study. Both reset cases succeeded after `storage.sync()` and
an intentional three-second future alarm; that full test delay remains in measured candidate time.
No candidate User alarm started a control User's Workflow before discovery.

An earlier immediate-reset pilot reached a child-observation deadline. It did not localize the
failure across publication, persistence and claimed handoff, so it does not establish a guarantee
for crash latency. Other pilots exposed fixture-only schema, closed browser caller, input-shape,
REST settlement and Free backfill mistakes. All are retained in the raw proof. The final fixtures
use the actual failure owner to settle synthetic no-op work rather than bypassing state constraints.

## Validation and limits

The queued-readback regression first failed with no scheduled wake. Native adapter tests now cover
queued and terminal readback, foreign User isolation, optional wake failure, competing deadlines,
retirement during an in-flight write and recovery after a rejected native write. Fresh WhatsApp
statement tests assert a wake; refused documents assert none. Existing hosted recovery and erasure
suites remain part of validation. The production code schedules an immediate wake; the test-only
future delay and forced actor reset are confined to the benchmark.

Raw observations, earlier failures and reproducible source are in
[the hosted proof](./hosted-statement-wakeup-proof-2026-10-29.json). All 66 targets across nine final and pilot resource prefixes independently returned 404 in
[the cleanup audit](./statement-wakeup-cleanup-2026-10-29.json). The study does not establish the universal 2× goal in issue #1589.

Sources: [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/),
[storage confirmation and output gates](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[named identity during alarms](https://developers.cloudflare.com/durable-objects/api/id/).
