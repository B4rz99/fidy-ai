# Budget scheduling clock decision (#1469)

Keep the proposed single User clock. Synthetic native D1 measurements show unchanged bounded
selection, cheaper attempt writes and no material discovery regression. Both implementations use
the preceding/current full baseline, the same 33 pending Users, immutable historical SQL for the
original owner and the published discovery/note operations for the target. Setup is excluded.
The original SQL is preserved in `cloudflare/budgets/scheduling.test-fixture.json`.

| Pending scopes per User | Cold Users | Kind           | Discovery rows read, original → shared | Attempt rows read | Attempt rows written |
| ----------------------- | ---------- | -------------- | -------------------------------------- | ----------------- | -------------------- |
| 1                       | 0          | financial work | 133 → 134                              | 14 → 3            | 3 → 1                |
| 1                       | 2,000      | financial work | 2,133 → 134                            | 14 → 3            | 3 → 1                |
| 100                     | 2,000      | financial work | 8,667 → 6,668                          | 905 → 3           | 300 → 1              |
| 32                      | 2,000      | publication    | 4,179 → 2,180                          | 165 → 3           | 32 → 1               |

Native counters include index/trigger work; these are not Transaction counts. The shared clock has no extra index to maintain: discovery sorts the grouped pending owners. Discovery groups only pending owners before joining
their clock, so it does not scan cold User roots or look up a root for every child record. Returned
Users remain bounded at 16. Generation remains bounded at four attempts per existing sweep. This
is not a constant-cost discovery claim: discovery still traverses the pending scopes, as before.
The one-read increase without cold Users is offset by the lower attempt cost even for a single
scope. No cadence, retry ceiling or background resource budget changes.

The fairness behavior test rotates 33 Users without processing authority, then invalidates an
already pending work scope and observes restored priority. Group publication and first-offer
proofs still use the original Consent owner. Existing Budget/Insights tests cover capture,
correction, backlog refusal, opt-in fencing, grouped publication and first-creation behavior.
The native cutover tests additionally protect exact observed-version completion and original
first-Budget identity even when that Budget no longer exists.

The clock is recorded before coordination/processing in the existing Insights runtime. New work
committed after that attempt resets the clock in its own atomic trigger; completing another scope
never updates it. A failed or partial evaluation therefore retains discoverable pending work.
Continuous new work can earn extra visits; it does not increase the per-sweep bound, and is subject
to the same finite batch/resource policy. No new Workflow or generic scheduler is introduced.

Reproduce locally with `INFRA_PERFORMANCE_MEASURE=1 bun run --cwd apps/server test:cloudflare
cloudflare/budgets/scheduling-cost.test.ts`. Raw counters live in
`budget-scheduling-measurements.json`. These are synthetic local measurements, not production load
or remote D1 quota consumption.
