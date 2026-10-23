# Recurring digest scan engine gate — #1475

Decision: retain `source_checkpoint`, `source_cursor`, `source_cutoff_at_ms` and
`source_complete` in `schedules`. Do not install a second digest generation path or a
`source_scan_id` column. This is the explicit fallback in #1475 and the cost gate in #1395,
not an implemented Workflow cutover.

## Native experiment

Run locally with the repository's supported Bun:

```sh
INFRA_PERFORMANCE_MEASURE=1 bun run --cwd apps/server test:cloudflare -- cloudflare/recurring/workflow-cost.test.ts -t 'native digest source'
```

The experiment uses native Miniflare/workerd D1 and Workflows. It seeds 384 real Transactions,
runs the installed detector through its User coordinator, and reads its 128 actual confirmations
through Recurring's published reader in four 32-item pages. Three alternating-order samples compare
direct Worker calls with four named native Workflow steps. Each Workflow checkpoint contains only
source cursor/count/completion metadata. No confirmation payload, Money, Counterparty or User text
is returned to Workflow history. The instance payload is version and User identity only.

The Workflow is an **optimistic overhead floor**, not the accepted lifecycle implemented in full.
It omits generation claim/release, staging, launch recovery, terminal replacement, final publication,
and erasure/cancellation. Both paths use the same production reader over the same unchanged facts.
The measured source D1 cost is collected separately through the existing native cost observer;
it is the shared reader cost, not separately instrumented Workflow storage or a billed production
estimate. The raw samples are in [digest-source-workflow-measurements.json](digest-source-workflow-measurements.json).

| Local observation                            |  Direct | Native Workflow floor |
| -------------------------------------------- | ------: | --------------------: |
| Median elapsed milliseconds, three samples   |    5.81 |                 12.08 |
| Confirmations / source pages                 | 128 / 4 |               128 / 4 |
| Shared production source-reader rows read    |     831 |           Same reader |
| Shared production source-reader rows written |      16 |           Same reader |
| Durable engine page checkpoints              |       0 |                     4 |

These small local timings do not predict production latency or Cloudflare pricing. Worker calls
and engine status polling are included; D1 content is unchanged between samples. The original
#1470 detector experiment remains separate and is not rerun or overwritten by the command above.

## Why the engine gate fails

Replacing four fields with one saves three columns. It does not remove source revision/Consent
guards, item staging, complete-source validation, atomic day publication, source dispositions or
retained day history. The existing cursor and each staged page commit in the **same D1 batch**;
there is currently no page-commit/engine-checkpoint gap to recover.

At this bound the current scanner updates one schedule row per page, four updates in a complete
scan. Even an optimistic removal of all four updates leaves the measured source-reader work and
at least 128 staging item upserts. The new generation claim/release would consume some of those
savings. Moving cursor progress to four durable engine checkpoints adds a separate consistency
boundary and launch/history/restart/erasure lifecycle. The floor already adds elapsed work; the
unimplemented correctness machinery cannot be credited as a simplification or a measured saving.

For three fields, that trade fails the accepted simpler-reliable-code gate. Keep the existing
bounded coordinator scanner. Reopen this decision if the source bound or independent execution
needs change; a full candidate must then prove the accepted stale-run, replay, source/Consent,
engine-history, erasure and resource-budget lifecycle before installation.

## Retained behavior and proof

`insights/recurring-digest.test.ts` continues to exercise actual public operations: every source
page is required, source revision changes invalidate an in-progress scan, publication freezes the
complete original ConfirmationDay, backward travel preserves distinct same-date windows, suppressed
and earlier-day sources stay excluded, repeated advance does not republish a day, and original
report facts and exact permission survive independently of delivery. Its populated multi-page case
also interrupts final report publication after source staging and checks that no partial report,
Event, Message or day result commits.

Existing integrated erasure and Workflow delivery checks remain applicable. No new generation
Workflow is installed, so claims about stale native generation instances, checkpoint loss or
history expiry are deliberately not made. The current scanner has no such instances: its durable
progress and staged page share D1 atomicity, and erased-User fences remain enforced there.

API shape was checked against installed Worker types and the current official
[Workers API](https://developers.cloudflare.com/workflows/build/workers-api/) and
[Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/).
