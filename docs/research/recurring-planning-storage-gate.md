# Recurring Planning storage gate — #1467

Status: **conversion halted; revised storage design needs acceptance**. The duplicate JSON revision
has not been removed. No production code, schema, migration ledger or remote database was changed
for #1467. Completed local predecessors: #1464, #1465, #1466.

## Why this blocks the accepted implementation

[#1467](https://github.com/B4rz99/fidy-ai/issues/1467) requires measuring supported document size
and contention before conversion and says to “halt if the bounded aggregate fails.” Its parent,
[#1413](https://github.com/B4rz99/fidy-ai/issues/1413), requires presenting a justified relational
design if the document fails, rather than silently expanding tables or changing product limits.

Cloudflare's current [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) specify
2,000,000 bytes for a string, BLOB or complete table row (checked 2026-10-22). The older bundled
Cloudflare reference's 1 MB figure is stale; this analysis uses the current official limit.

A document accepted by the existing `RecurringDocument` codec, containing 100 plans with 100
revisions each, is **4,757,307 bytes**. Native D1 refuses its insertion with `SQLITE_TOOBIG`.
Removing the top-level JSON revision leaves **4,757,290 bytes**, saving only 17 bytes. It cannot
make the accepted aggregate fit.

This counterexample uses ordinary `1000000 COP` Money, valid monthly schedules, 120-character
names/counterparties, and distinct, ordered effective dates and names. It uses neither unusually
large Money nor any pauses, exceptions, fulfillments, exclusions or suggestion decisions. Those
additional supported collections can only increase its size. The existing bounds allow 100 plans,
100 revisions/pauses per plan and 4096 entries per decision collection. This is a supported-shape
counterexample, with the global revision set to the number of plan creation/edit decisions,
not a claim that every User accumulates this much history.

## Reproduce and interpret

```sh
INFRA_PERFORMANCE_MEASURE=1 bun run --cwd apps/server test:cloudflare cloudflare/recurring-plans/recurring-plans.test.ts
```

The opt-in measurement extends the existing public Planning/native D1 seam, without a production
benchmark interface. Each case uses an isolated native database, validates/encodes the full document
with the owned codec, attempts persistence, and reads stored cases through the existing canonical
Planning operation. It then submits two edits with the same expected revision through the canonical
owner. The native fixture seeds supported history directly; it does not issue 10,000 HTTP edits or
claim that setup time measures a real User's editing session.

[Raw observations](recurring-planning-storage-measurements.json) contain dimensions and costs only.
They omit document bodies, error stacks and database contents. Local elapsed times are descriptive,
not production service-level evidence. `-1` means the operation was not attempted after storage
refusal; it is not a negative duration. The byte-limit flag checks the candidate JSON value alone;
a complete D1 row also needs room for its other fields.

| Plans | Revisions per plan | Current JSON bytes | Without JSON revision | Native storage         |
| ----: | -----------------: | -----------------: | --------------------: | ---------------------- |
|   100 |                  1 |             54,805 |                54,790 | accepted               |
|   100 |                 25 |          1,194,806 |             1,194,790 | accepted               |
|   100 |                100 |          4,757,307 |             4,757,290 | refused: SQLITE_TOOBIG |

The stored cases retain compare-and-swap safety: exactly one competing edit commits and advances
the document from revision 100 to 101 (one snapshot per plan) or 2500 to 2501
(25 snapshots per plan). The other is refused. This run reports 200/503 when both requests
prepare before the same native guard; a request observing the new revision during preparation can
instead receive the existing 400 stale-edit refusal. This measurement does not change refusal
policy. It exercises the published canonical owner directly, not coordinator queue throughput.
Row counters for the competing pair are 49 read / 14 written in both stored cases, but those counts
hide the much larger JSON payload transferred and rewritten in the 25-revision case.

## Nested-field assessment

- The row revision duplicates the top-level document revision and remains a valid cleanup target,
  once the storage gate is resolved. An absent workspace must still expose revision zero.
- `plan.currency` and `plan.money.currency` repeat the denomination when Money is known. A private
  storage codec could omit the nested copy and reconstruct/validate it, while preserving the public
  Money contract. Even eliminating this small repeated field does not repair a 4.76 MB aggregate.
- A revision's `from` and its plan's `firstDate` cannot generally be merged: the effective date and
  schedule anchor can differ, including clamped-month behavior. This fixture happens to align them;
  that does not establish a removable invariant.
- Full historical plan settings preserve original expectations. Repeated names, counterparties or
  schedule parameters across revisions are historical values; replacing them with current settings
  would rewrite the past. A patch-chain design would need new replay and validation rules and is
  not proposed as a shortcut.
- Exceptions, fulfillments, exclusions and suggestion decisions express separate User decisions.
  Generated future occurrences still need no persistent rows.

## Proposed revised design — not implemented

Keep the shared four-column `user_documents` row as Planning's small concurrency root. Its JSON
holds only bounded exclusions and suggestion decisions; its SQL `revision` is the sole stored
workspace revision. At both existing 4096-entry bounds, canonical UUID exclusions and linked
suggestions occupy 663,596 bytes together. This is a calculated bound for that proposed payload,
not a measured approval of new runtime behavior.

Add four Planning-owned tables:

| Table                         | Proposed columns and SQL types                                                                                                                                                            | Why separate                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `recurring_plans`             | `user_id TEXT`, `id TEXT`, `pauses_json TEXT`, `stopped_on TEXT NULL`                                                                                                                     | Stable plan identity/lifecycle; at most 100 bounded date-only pauses per plan. No duplicated current settings.    |
| `recurring_plan_revisions`    | `user_id TEXT`, `plan_id TEXT`, `from_date TEXT`, `plan_json TEXT`                                                                                                                        | One effective-dated settings snapshot per row, so 100 plans × 100 revisions cannot overflow one SQL value.        |
| `recurring_plan_exceptions`   | `user_id TEXT`, `plan_id TEXT`, `local_date TEXT`, `skipped INTEGER`, `replacement_json TEXT NULL`                                                                                        | One explicitly changed/skipped occurrence, including its optional historical replacement settings.                |
| `recurring_plan_fulfillments` | `user_id TEXT`, `id TEXT`, `plan_id TEXT`, `local_date TEXT`, `actual_date TEXT`, `amount TEXT`, `currency TEXT`, `settled INTEGER`, `automatic INTEGER NULL`, `transaction_id TEXT NULL` | Individually addressed actual completion/reversal records and exact Money, without a growing Money-bearing array. |

Use same-User plan identities and foreign keys for owned children. Preserve Transaction and Series
association checks through their owning modules. Keep local calendar dates as dates, not instants.
The bounded JSON on each plan contains date-only pause periods; exceptions/revision rows each hold
one operation's accepted settings rather than all settings history. The root collections contain
only bounded identifiers and decisions, not Money-bearing records. The implementation must verify
existing per-operation payload limits and each proposed row's worst-case byte bound before cutover.

All child writes, root revision compare-and-swap and Audit commit together. Public Planning operations
reconstruct the existing document/workspace and keep empty revision zero, expected-revision refusal,
exact matching, computed occurrences, clamping, pauses, skips, reversals and erasure purposes. One
Planning-owned storage module hides the representation; callers should not learn the table layout.

This is five coherent stores for the feature: the existing shared root plus four tables, a net
increase of four physical tables. Each has a distinct bounded lifecycle/cardinality. This proposal
needs review/acceptance because it replaces the accepted single-document design, rather than being
an incidental implementation detail of revision removal.

Before accepting implementation, validate public response size/cost and bounded SQL reconstruction,
concurrent edits, all supported collections, same-User associations, populated conversion and
rollback, and original archive/erasure addressing. Do not silently reduce the existing limits,
discard historical revisions, add an arbitrary generic record store or start this redesign merely
to make a table-count target fit. #1467 remains unfinished; #1468–#1494 have not been started in this
sequential batch.
