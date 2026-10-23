# Recurring storage and execution decision (#1470)

Retain persisted fact/proposal scratch and the existing User-coordinator evaluation loop. Retain
`cursor_at`/`cursor_id` (converted to the final timestamp representation in #1471); the conditional
Workflow cursor removal does not pass its benefit gate. No run-fence column or production Workflow
is introduced. The selected evaluation store therefore retains 15 columns, rather than the
conditional 13-column proposal. This is an explicit gate outcome, not an achieved reduction.

## Bounded direct reads versus scratch

`cloudflare/recurring/detection-comparison.test.ts` exercises Transactions' published
`findRecurringSnapshot`/`readRecurringFacts`, the pure monthly-v1 detector and the public Recurring
list operation. Histories contain exact fractional COP and USD Money in separate Counterparty/Currency
groups over consecutive calendar months. The complete typed proposal JSON is compared with the staged native proposal before installation,
including exact reference Money, support identities, latest identity and backfill. Both paths also
produce the same public Counterparty, exact current Money, Currency and first/last occurrence instants. All seeded public series are returned; the large
fixture has exactly one full 32-series page. The comparisons use the same source revision and zone.
Existing Recurring tests retain broader correction, Reconciliation, confirmation, pagination,
Consent, capacity, weekly eligibility and interruption coverage.

The direct candidate is deliberately bounded: retain at most 512 facts for one next group and 128
proposals; stream source pages of at most 128 facts. It finds the next normalized group in one full
source traversal, avoiding an unbounded all-history/all-Counterparty buffer. Once that group is
processed, it traverses again for the next group. A final traversal proves no group was missed.
Unlike scratch, the published Transaction interface is ordered by occurrence/identity, not detector
group. The candidate does not read Transaction tables or reimplement Reconciliation.

| Transactions / groups | Scratch rows read | Direct rows read | Scratch rows written | Direct rows written | Scratch calls / direct source pages |
| --------------------- | ----------------- | ---------------- | -------------------- | ------------------- | ----------------------------------- |
| 6 / 1                 | 137               | 52               | 45                   | 0                   | 4 / 2                               |
| 128 / 8               | 1,796             | 4,745            | 620                  | 0                   | 12 / 18                             |
| 2,000 / 32            | 82,395            | 2,157,938        | 8,438                | 0                   | 50 / 528                            |

These are local native D1 counters, including indexes/triggers, excluding setup and public/native result observation.
The scratch column includes initialization, staged detection and final installation. Direct costs
are a favorable **lower bound**: they cover source reads and pure detection only, without durable
restart checkpoints, proposal/series installation, prior-series matching or atomic publication.
Adding those responsibilities cannot erase its 26-fold read amplification in the large fixture.
This is sufficient to reject deleting scratch; it is not a claim that a complete alternative was
implemented or that its zero writes could preserve existing behavior. A tiny-history fast path
would add a second detector execution design and is not selected.

`maximumGroupFactsHeld` in the raw results is the retained group size, not total process memory:
both paths also hold decoded page/proposal structures. The direct experiment does not introduce a
new unlimited memory budget. A group above 512 and more than 128 proposals refuse; no silent truncation
is a proposed production behavior. The existing executable boundary tests remain authoritative.

## Native Workflow overhead and optimistic cursor savings

`cloudflare/recurring/workflow-cost.test.ts` runs actual local Miniflare/workerd Workflows and SQLite
User Durable Objects, not a mocked `step.do`. Each fresh runtime receives either 128 Transactions /
eight groups or 2,000 Transactions / 32 groups. One mode invokes the real `/recurring-work`
coordinator for the required 12 or 50 calls; the other invokes the same coordinator in named
Workflow steps. Both reach a complete source with the expected eight or 32 confirmations. Setup
and bundling are excluded. Each run has its own runtime and storage.

| Transactions | Sample | Direct coordinator ms | Workflow wrapper ms |
| ------------ | ------ | --------------------- | ------------------- |
| 128          | 0      | 76.783                | 90.537              |
| 128          | 1      | 69.491                | 79.390              |
| 128          | 2      | 63.143                | 77.791              |
| 2,000        | 0      | 394.238               | 381.955             |
| 2,000        | 1      | 372.872               | 401.161             |
| 2,000        | 2      | 388.739               | 391.950             |

The local medians are 69.491 → 79.390 ms and 388.739 → 391.950 ms. The larger case has overlapping
samples, so it does not establish a meaningful latency penalty. These timings include local
start/status polling; they are observations, not stable production latency or billing estimates.
The Workflow wrapper still performs the original D1 cursor updates, so its timings alone cannot
settle the cursor-removal gate.

A cursor-less design **could remove intermediate scan-page progress updates**, because their phase
stays `scan`. The final page must still advance phase; initialization, group detection and completed
revision/time writes also remain. We measured the most favorable bound directly from the original
native statement costs: identify scan cursor updates, exclude the last (phase-changing) one, and sum
all remaining rows read/written, including index/trigger work. The bound credits removal of their
entire cost, even though a real replacement must retain revision/phase/Consent fencing.

| Transactions | Scan pages | Optimistically removable intermediate updates | Avoidable D1 row writes / total | Avoidable row reads / total | Added Workflow steps |
| ------------ | ---------- | --------------------------------------------- | ------------------------------- | --------------------------- | -------------------- |
| 6            | 1          | 0                                             | 0 / 45                          | 0 / 137                     | 4                    |
| 128          | 2          | 1                                             | 2 / 620 (0.32%)                 | 6 / 1,796                   | 12                   |
| 2,000        | 16         | 15                                            | 30 / 8,438 (0.36%)              | 90 / 82,395                 | 50                   |

This is an executable optimistic savings bound across multiple intermediate pages, not a claim
that cursor removal saves nothing. It does not measure the small reduction in D1 row bytes from
removing two cursor values. Nor does the local experiment measure engine storage billing. It does
show that the proposed shift saves less than 0.4% of evaluation row writes in the measured histories,
while adding a durable Workflow lifecycle and a checkpoint per evaluation step. The example
histories do not justify a universal performance claim.

Select the current coordinator/cursors: the measured benefit is too small to justify a second
recovery/erasure design, and the native wrapper demonstrates no repeatable speed improvement.
This is a conservative design decision under the parent gate, not a proof that every possible
Workflow implementation would be slower or more expensive. A real cursor-less replacement also
needs metadata retention/erasure, dispatch recovery, duplicate-page and terminal-history-loss
handling. Those costs were excluded from this favorable comparison. There is no proven resource
advantage sufficient to accept that extra design here; retain both cursor fields explicitly.

The experimental Workflow checkpoints only a step number; input is versioned User/revision/step
metadata. No financial payload, Counterparty or proposal enters engine history. It is never bound by
production infrastructure. It does not claim to prove cursor-less recovery, stable-instance retry
budgets or a production engine migration. The current D1 cursors already resume without platform
history and remain the selected durable model. The published [Cloudflare Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)
was checked against installed platform types on 2026-10-22; `step.do` persists step results and adds an
independent execution lifecycle. No platform prices or remote quota use are inferred from this test.

## JSON payload audit

The apparent overlap in `recurring_series` has several different meanings:

| Payload/field                                                         | Is it reconstructible from other retained facts?                                                                   | Decision                                                                                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `series_json.id` and row `id`                                         | Yes, after validating historical equality; same stable series identity                                             | Optional encoded-payload reduction in #1471; no need to remove the indexed identity column                                                                               |
| `series_json.confirmedAt` and optional confirmation time              | Not for every history: original confirmation may be absent or independently erased                                 | Preserve unless an equally precise non-confirmation source is retained                                                                                                   |
| `series_json.money/counterparty` versus `confirmation_json`           | No: current supported pattern may change; first confirmation is immutable                                          | Keep original snapshot independently                                                                                                                                     |
| `series_json.cadence/announcement` versus confirmation                | Current monthly-v1 often agrees; original historical eligibility/absence is not inferred from a current pattern    | Preserve confirmation's original values                                                                                                                                  |
| `currency` and normalized `counterparty_key` versus current series    | Reconstructible for valid matching rows, but used for indexed group/order/cursor keys                              | Retain indexed projections; validate their correspondence at cutover                                                                                                     |
| `reference_json` versus current displayed Money                       | No: initial exact Money anchors the 5% comparison; displayed Money is the latest compatible observation            | Keep fixed reference                                                                                                                                                     |
| `evidence_json.supportingTransactionIds` versus `latestTransactionId` | No: initial three supporting IDs persist when a later observation extends the series                               | Keep both                                                                                                                                                                |
| `evidence_json.evaluatedFactRevision` versus current User revision    | No: current financial facts may have changed while retained results are updating                                   | Keep completed evidence revision                                                                                                                                         |
| `evidence_json.detectorRevision`                                      | Required interpretation of retained evidence, not the current source revision                                      | Keep                                                                                                                                                                     |
| `confirmation_json.id/seriesId/confirmedAt` versus columns            | Some scalar duplication is reconstructible only when the original all-or-none confirmation group exists and agrees | A compact stored confirmation codec may derive those scalars in #1471 after populated validation; never replace historical Money/context/eligibility with current values |
| `confirmation_context_json` versus current UserContext                | No: captured zone/market/locale is historical                                                                      | Keep original context                                                                                                                                                    |

The fixed reference and latest evidence are proven distinct by the implementation in
`src/core/recurring/operations.ts`: `proposalFrom` fixes the first Money and support triple;
`extendProposal` updates displayed Money and latest ID without rewriting them. Confirmation writes
in `cloudflare/recurring/internal/evaluation.ts` occur only on first installation; later updates
replace current series/evidence/reference while preserving the confirmation group. Independent
confirmation erasure and legacy absence prevent assuming all duplicate-looking fields can be
reconstructed for every historical row. No original confirmation facts are removed in this gate.

## Follow-through

#1471 should use the current bounded coordinator model, retain scratch and both cursor fields,
convert instants/cursors losslessly, and keep prior completion evidence through initialization.
Any compact JSON codec must reject unexplained key/snapshot mismatches, preserve absent confirmations
and independent logical erasure purposes, and prove populated conversion/rollback plus existing
public behavior. This gate performs no schema cutover, so there is no data conversion or rollback
to run for #1470 itself. The sole baseline remains unchanged.

Reproduce locally with `INFRA_PERFORMANCE_MEASURE=1 bun run --cwd apps/server test:cloudflare
cloudflare/recurring/detection-comparison.test.ts cloudflare/recurring/workflow-cost.test.ts`.
Raw observations are `recurring-detector-measurements.json` and
`recurring-workflow-measurements.json`. Neither test contacts a remote database or starts a remote
Workflow. Existing public behavior tests run separately without performance mode.
