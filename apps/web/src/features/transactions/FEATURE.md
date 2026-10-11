# Transactions

`/app/transactions` displays the User's current local month. This is a capability and verification map, not a separate specification.

| Capability              | Behaviour                                                                                                                                                                                                                            | Verification                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browse                  | Reads 100 Transactions first. Scrolling near the end requests the declared next page; editing pauses continuation. Refresh or a saved correction starts again at page one.                                                           | Local browser: 0/100/101/201 records, equal sort keys, no eager continuation, draft pause, refresh, duplicate prevention. Production scrolling check pending deployment. |
| Filter and organise     | Searches Counterparty/notes, filters direction, Category and local date; clears filters, sorts within date groups and hides optional columns. Filters apply to loaded records.                                                       | Local rendered/browser checks; Production passed search (including notes/no match), direction, Category, date, sort and column toggling on 2026-10-10.                   |
| Summary                 | Counts and exact Money summaries follow the loaded filtered records. Different Currencies remain separate.                                                                                                                           | Local presentation checks; Production counts, inflow/outflow totals, average and date range matched synthetic records. Live multiple-Currency history not exercised.     |
| Capture                 | Positive COP Money, local date, optional Counterparty and direction; server assigns Category.                                                                                                                                        | Local rendered/browser, Core and Worker/D1 checks. Production outflow and inflow saved and survived reload.                                                              |
| Individual correction   | Edits the same Transaction using its observed revision. Cancelling discards the draft.                                                                                                                                               | Local rendered/browser and Worker/D1; Production amount correction, cancellation and persistence passed.                                                                 |
| Inline Category         | Assigns a stable Category identity without creating a new Transaction.                                                                                                                                                               | Local rendered and Worker/D1; Production correction survived reload and matched the Category filter.                                                                     |
| Bulk correction         | Up to 12 selected Transactions change atomically with observed revisions; mixed-Currency selection cannot share a Money amount.                                                                                                      | Local rendered and Worker/D1 checks. Production two-record notes correction verified on both records. Live size limit/mixed-Currency refusal not exercised.              |
| Concurrent correction   | A stale observed revision cannot overwrite a newer correction.                                                                                                                                                                       | Local Worker/D1 and rendered checks; Production two-tab competing save was refused, with an explicit refresh action.                                                     |
| Loading and failure     | Retains loaded history during continuation failure; explicit retry repeats the same bounded page. Stale reads disable edits; uncertain saves require reading before another decision. Expired authentication clears financial state. | Local rendered/browser and Worker/D1 checks. Live provider/network failure and session expiry were not induced.                                                          |
| Responsive interaction  | Desktop detail panel becomes a mobile sheet; draft/pending edits preserve their interaction state.                                                                                                                                   | Local rendered/browser checks. Production responsive check pending.                                                                                                      |
| Ownership and integrity | Canonical operations enforce same-User authority, current Consent, exact Money, revisions, immutable SourceAttestations and Audit.                                                                                                   | Core and real local Worker/D1 negative checks. Production anonymous access check pending; cross-User mutation not attempted against live accounts.                       |

## Owners

- `feature.tsx` and `history.ts` project the authenticated canonical query lifetime and declared continuations.
- `workspace.tsx` owns filters, the scroll sentinel and panel interaction; capture, detail, inline Category, bulk correction and summary stay in this directory.
- Server Transactions owns capture/correction/history/search and persistence. Public Ingress reaches private Core/D1; browser fixtures do not prove deployed infrastructure.
- This view has no Reconciliation, deletion or SourceAttestation history controls. Those canonical capabilities require a separate map and checks.

## Evidence

2026-10-10 local rerun:

- 49 rendered/presentation/transport-boundary Transactions checks passed.
- 31 Core checks and 122 actual local Worker/D1 checks passed.
- Built-browser HTTP-fixture checks cover capture and public response rendering plus paging/interruption/retry/refresh/authentication replacement. They substitute the HTTP response and are not real Production evidence.

Production on 2026-10-10: authenticated approved test User, clearly labelled `PRUEBA QA` records. API and web reported matching revision `eeb3405ba58e4974fedf8e420b58e593424e2a60` during testing; earlier actions began on `8f402a4ece08ad193bee5e0a9f619d3bf1fc835b`. The table above separates observed live behaviour from local coverage and remaining checks. Synthetic records remain labelled; no permanent deletion was performed.

## Rerun

```sh
bun run --cwd apps/web test src/features/transactions
bun run --cwd apps/server test:core src/core/transactions --coverage.enabled=false
bun run --cwd apps/server test:cloudflare cloudflare/transactions --maxWorkers=1
bun run --cwd apps/web test:browser transaction-pagination.spec.ts financial-journeys.spec.ts --workers=1
```

For live reruns, use a logged-in approved test User and only labelled synthetic records. Check summary arithmetic, save/reload individual and bulk corrections, reject a stale edit from another tab, then verify page one loads before scrolling and the next page appears at the end. Record the matching web/API revision and distinguish safe live checks from failures only simulated locally.
