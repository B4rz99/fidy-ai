# Budget contribution paging performance — 2026-10-11

The canonical measurement suite exposed repeated effective-source scans during exact Budget reconciliation. The largest capture retry read 107,272 D1 rows over 5,001 qualifying outflows. The dashboard's 16,464-read sample instead computes an exact aggregate over 8,193 Transactions; that result requires the represented facts and is not a bounded list-page sample.

Budget contribution pages now select the maintained Transaction projection when its version and readiness match, within the same SQL snapshot. An unavailable or repairing projection selects the authoritative effective source. A compound index seeks directly after the `(occurred_at, id)` cursor, including equal timestamps. The initial cursor is clamped to the half-open month's beginning. Each page still contains at most 512 contributions; the report still shares its eight-page work allowance across all Budgets. Exact decimal sums, revision checks, durable checkpoints and refusal/rollback behavior remain in the existing owners.

Four identical native growth cases compared baseline `4aed775b4` with the candidate. Adjacent JSON retains every Core and held-owner observation separately. Core observations exclude coordinator work, and held-owner observations exclude transport admission; these overlapping boundaries must not be added.

| Case / boundary                                     | Before reads | After reads | Reduction | Before / after writes |
| --------------------------------------------------- | -----------: | ----------: | --------: | --------------------: |
| Status with 5,001 unrelated outflows, Core          |        5,025 |          25 |     99.5% |               21 / 21 |
| Capture after qualifying-month progress, held owner |       95,964 |      42,571 |     55.6% |             111 / 113 |
| First expensive capture refusal, held owner         |       65,717 |      12,332 |     81.2% |                 8 / 8 |
| Expensive capture retry, held owner                 |      107,272 |      45,296 |     57.8% |             113 / 115 |
| Status after that retry, Core                       |       11,330 |       2,747 |     75.8% |               22 / 22 |

The index adds storage and maintenance work: two extra writes for accepted captures in these fixtures (projection replacement deletes and inserts). Migration 0085 builds it once over the retained projection. This is an additive index migration; existing applied migrations are unchanged. It does not remove the more expensive authoritative fallback during repair.

Verification: 39 native tests passed with 2 existing skips across Budget journeys, Transaction query costs and projection write costs. A new native case checks 513 equal-time contributions across two pages, a pre-month cursor, foreign-User isolation, bounded ready-projection reads and authoritative fallback after deliberately clearing a dirty projection. SQLite's query plan confirms the compound cursor is the index lower bound. Typecheck and dependency checks passed; CI supplies the broader adapter checks before merge.

These are controlled local D1 read/write comparisons. Local timing and host-process CPU do not establish hosted Worker CPU, a production latency improvement, or a production SLO. Production promotion remains blocked by exhausted Workers AI daily allocation at the existing conformance gate.

Cloudflare documents [index selection and its read/write tradeoffs](https://developers.cloudflare.com/d1/best-practices/use-indexes/). The query's lazy snapshot selection follows the existing Transaction-owned effective History policy in `effective-transaction.ts`.
