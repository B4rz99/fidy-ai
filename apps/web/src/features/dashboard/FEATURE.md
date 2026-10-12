# Dashboard

Capability and verification map for `/app/dashboard`. This records implementation evidence, not a replacement for GitHub product requirements.

## Behaviour

| Capability        | Implemented behaviour                                                                                                                                                                                                             | Evidence                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First use         | Read the canonical view. Only `DashboardUninitialized` permits explicit initialization, followed by one fresh read. Unavailability never means absence or triggers recursive initialization.                                      | `query.ts`, rendered route checks, and seven built-browser loading scenarios.                                                                                                     |
| Financial results | Four Widget variants render spending buckets, budget availability, Transaction lists, and custom metrics. Server-calculated periods and currency groups remain authoritative. Missing or malformed data is not invented as Money. | Presentation tests, Core calculation/aggregation tests, and schema-decoded view.                                                                                                  |
| Money             | Display uses authoritative decimal text, including values beyond safe binary-number precision. Charts use bounded dimensionless geometry without replacing Money with floating-point amounts.                                     | Six exact-Money presentation checks.                                                                                                                                              |
| Layout            | The canonical recursive layout controls desktop axes and relative shares. Mobile stacks in canonical reading order.                                                                                                               | Responsive presentation and layout rule checks.                                                                                                                                   |
| Personalization   | “Personalizar” reveals catalog drag sources, named keyboard destinations, Widget title/removal controls, and boundary resizing. Gestures compile to canonical edits.                                                              | Drag adapter, editor model, rendered feature, and command checks.                                                                                                                 |
| Saving            | Each gesture sends its edit immediately through a serialized queue. “Guardar” exits editing; it does not commit a separate unsaved document. Successful edits invalidate the canonical view.                                      | `feature.tsx` and queued-command checks.                                                                                                                                          |
| Failure recovery  | Rejected edits and uncertain outcomes have different copy. A successful save followed by failed refresh retains the prior canvas and reports stale evidence. Catalog and view retries have independent ownership.                 | Feature/controller tests.                                                                                                                                                         |
| Dashboard title   | The server supports `set-title` and returns the resulting User-visible title. The development heading now renders that canonical value with the existing typography.                                                              | A new rendered regression failed before the fix and passed after it; real local Worker/D1 and built-browser read-after-edit also passed; production verification remains pending. |

## Owners

- `feature.tsx` owns independent query feedback and serialized canonical edits.
- `query.ts` owns read/initialize/read and its workflow phase.
- `editor-model.ts` translates closed UI gestures to canonical edits.
- `drag-adapter.tsx` owns drag transport validation and semantic destinations.
- `view.tsx`, `presentation.ts`, and Money presentation own rendering.
- Server Core Dashboard owns the document grammar, edit rules, periods, aggregation, and authoritative results. Cloudflare adapters own admitted persistence and execution.

## Placement feedback

Dragging keeps the confirmed layout still and highlights the chosen destination in green with its placement label. Mouse/pen drags require eight pixels of movement; touch retains its hold-to-drag constraint. The resulting arrangement appears only after dropping. A catalog Widget shows a placeholder until Core calculates its results.

Dropping shows the placement immediately and announces “Guardando cambio…”. Editing stays disabled until the canonical reread completes. Refused or uncertain edits and failed rereads restore the last confirmed arrangement; an uncertain edit is never automatically replayed. The preview is transient presentation state, not another persisted Dashboard document.

`dashboard-editing.spec.ts` checks delayed saves, delayed and failed rereads, lost acknowledgment, and keyboard cancellation through the built browser. `dashboard-core.spec.ts` checks stable hover geometry and persisted edits through public Ingress, private Core, and local D1. Missing Widgets offer an explicit canonical refresh rather than a generic validation error.

Historical Production revision `03d94db6b3546c995be65b72c75515ae27707235` ([PR #1229](https://github.com/B4rz99/fidy-ai/pull/1229)) passed live pointer verification on 2026-10-12: hover rendered the proposed full Widget arrangement, Escape removed the preview, and a dropped swap displayed the new placement immediately before its canonical reread. The swap survived reload. Reversing it and reloading restored the original four titles and desktop positions. Deployment metadata matched the tested revision. Delayed saves and failure recovery were exercised locally, not induced in Production.

The React follow-up on 2026-10-12 passed **448 web checks**, including **59 Dashboard checks**. Global coverage met the repository thresholds: statements 94.25%, branches 90.12%, functions 92.44%, lines 95.17%.
All **9 placement browser checks** passed: five real local Core/D1 journeys and four response-fixture journeys.

The stable-feedback follow-up passed **449 web checks**, including **60 Dashboard checks**, and **10 placement browser checks**. It reproduces tiny-motion activation and verifies that hovering leaves Widget geometry unchanged, while dropped placement still appears before acknowledgment.

Production revision `f47063479d21c1753efa49be3e5cbe273086b423` ([PR #1237](https://github.com/B4rz99/fidy-ai/pull/1237)) passed live pointer verification on 2026-10-12. A two-pixel handle movement did not activate dragging. A deliberate drag showed the labeled green destination while all four Widget positions and dimensions stayed unchanged, allowing for scroll offset. Escape canceled without an edit. Dropping a swap returned HTTP 200, refreshed the canonical view, and survived reload. Reversing the swap and reloading restored the original four titles and order. No browser console warnings or errors were observed. Deployment metadata matched this revision, and the Production deployment workflow passed. The prior HTTP 404 was a stale Widget reference; its explicit refresh message is covered locally rather than induced again in Production.

## Verification

On 2026-10-11, audited release checkout based on `a2483f5dd1939fc3c3a37887c4e93c8081893666` passed:

- **44** web feature checks across seven files.
- **70** Core checks across six files.
- **7** built-browser initial-load scenarios: fresh/existing, denied/failed initialization, failed/absent second read, and failed initial read.
- **71** actual local Worker/D1 checks: admitted Dashboard operations, ownership refusals, persistence and retained evidence.

A separate `dashboard-live-title.spec.ts` check signed in through real Core, edited the title through admitted HTTP, reloaded the built browser, and verified the persisted heading (**1 passed**). It uses isolated local D1 and no route interception.

The real built-browser customization check also passed (**1 check**, 12.5 seconds): rename through the visible Widget editor, verify the name after reload, remove that Widget, and verify removal after another reload. Its first assertion stopped at a temporary 429 resource refusal; the corrected test waits for the client's admitted retry and then checks persisted UI state. Application code and admission policy were unchanged.

The seven initial-load built-browser scenarios intercept API responses. They verify the built UI and request sequence, not production financial results. The separate Worker/D1 suite exercises actual local persistence and admitted execution. This document is an audit artifact in the development checkout, not evidence that this checkout has been deployed.

## Historical Production evidence and remaining checks

- [Issue #1214](https://github.com/B4rz99/fidy-ai/issues/1214): canonical title was ignored by the web heading. The focused regression reproduced it, then all **45 web feature checks** and **24 application checks** passed after rendering `view.title`. The real local browser edit/reload check also passed. The fix merged in [PR #1216](https://github.com/B4rz99/fidy-ai/pull/1216); the historical deployment failure from live Workers AI preflight was resolved by the later quota-aware pipeline. Canonical-title edit/read-after-reload remains unverified in production.
- Real admitted Dashboard initialization/edit/read, ownership refusals, and retained Audit evidence passed the local Worker/D1 suite; repeat production behaviour separately.
- Earlier Production checks on 2026-10-11, before the React restoration in PR #1233, verified the original four Widgets, ten recent Transactions, separate Money directions, and explicit missing Budget. Rename, keyboard resize, pointer swap/edge movement, keyboard cancellation, catalog insertion and approved removal survived reload; original identities, order and weights were restored. These are historical release observations, not verification of the current React placement fix.
- Production revision `72ddd85d9a73487a7f0f0e457700225012d718f4` verified disposable funded Budget fixtures: `1600` COP spent against caps `2000`, `1600` and `1500`. A `12.34` USD Transaction appeared separately from COP in the list, chart and metric. Fixtures were removed through canonical operations; the Dashboard matched its baseline except calculation time, and browser reload confirmed cleanup.
- First use with a fresh approved Production User and physical touch gestures remain unverified live. Local negative tests cover ownership, withdrawal of Consent and failure recovery; failures were not induced in Production.
- Production monthly totals matched the complete retained Transaction history before and after the approved three-fixture cleanup below. Direct production Audit/SourceAttestation retention passed the bounded read-only storage observation below.

```sh
bun run --cwd apps/web test src/features/dashboard
bun run --cwd apps/server test:core src/core/dashboard --coverage.enabled=false
bun run --cwd apps/web test:browser dashboard-queries.spec.ts --workers=1
BROWSER_COST_MEASUREMENT=1 bun run --cwd apps/web test:browser dashboard-live-customization.spec.ts --workers=1 --timeout=120000
bun run --cwd apps/server test:cloudflare cloudflare/dashboard --maxWorkers=1
```

Production aggregation observation, 2026-10-12, React release `274f64ecdb1ff2d2997ecc52202d9e446e361653`: the monthly metric displayed COP 2,500 income and COP 6,387 spending. Transactions showed COP 2,931 spending for the first 100 loaded records, then loaded the remaining COP 3,456 test record. The complete-history sum matches the Dashboard spending metric. This is live aggregation evidence with existing fixtures; it does not establish canonical-title editing, source/Audit retention after deletion, or every Widget variant.

Production cleanup verification, 2026-10-12, release `804b122e7f68eec439f165b42cf99b6aedff99f1`: after the three explicitly approved chat fixtures were deleted through exact hosted challenges, reloaded Transactions showed 99 retained rows, COP 2,500 income and COP 1,697 spending, with all three deleted names absent. Dashboard monthly income/spending matched those values. Only those three fixtures were deleted; the other labelled fixtures remain. Production retained Audit/SourceAttestation storage was not inspected.

Production retention observation, 2026-10-12: a bounded read-only D1 query addressed only the three approved chat-fixture Transaction identities. Each retained Transaction had a deletion marker and exactly one retained SourceAttestation. The owning User had three successful `transactions.deleteTransaction` Audit entries in the checked 2026-10-12 UTC window. Audit has no per-Transaction reference, so the aggregate count does not independently attribute each entry to a fixture. D1 reported zero writes. No raw attestation contents, credentials or unrelated financial records were queried. Together with the exact hosted deletion receipts and the reloaded History/Dashboard observations, this establishes retained capture evidence and aggregate deletion accountability for this cleanup.
