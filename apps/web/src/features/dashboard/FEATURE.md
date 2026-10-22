# Dashboard

Production cross-feature read, 22 October 2026, deployed release
`20fd17a37458f54031c771d0b9e1de24a5e98933`: after the scoped Budget test updated the
Restaurantes cap to COP 23,456, navigating to Dashboard displayed that same cap and available
amount in its existing Budget Widget. The cash-flow Widget and recent-Transaction table agreed on
COP 10,103 expenses (COP 10,000 plus COP 103), with COP 0 income. No Widget was edited in this
check. Natural-language title edit/restore remains unverified after this reset. The test Budget cap
is retained pending exact cleanup approval; the original Transactions remain untouched.

Production D1-reset read verification, 20-10-2026 Bogotá: successful
[deployment 39525764609](https://github.com/B4rz99/fidy-ai/actions/runs/39525764609)
and API health identified release `da6dc816e10655f8b21fe13d8e61801d0f9d4c1c`. The existing session loaded catalog and
view with HTTP 200. The four retained Widgets remained visible, with October COP 0 income and
COP 10,103 spending. Transactions independently showed two expenses totaling COP 10,103;
Budgets showed the same uncapped spending. No Widget definition or title was changed.
The failed recurring chat draft survived route navigation and popup reopening without replay.
Natural-language Dashboard edit/restore remains unverified because the hosted provider returned
its daily-quota refusal on the preceding recurring test, independently of the recovered D1 reads.

Audit continuation, 20-10-2026, trunk `ef1005e310151e98ad946858051a0b8cffdaa945`:
all 69 native Dashboard Worker/D1 checks passed. Catalog, quota/Subscription discovery and
uninitialized reads now exercise the production recovery wrapper with isolated real R2 storage;
the two Users' absent Dashboards remain absent. This does not claim production persistence.
Production catalog and view requests repeatedly returned 503, so no Widget was renamed or
created for the pending chat test. Categories and Recurring subsequently failed too. A protected
[signed database proof](https://github.com/B4rz99/fidy-ai/actions/runs/39455413477) confirmed daily
D1 quota exhaustion. Public health still reported release `82c937fbd410f89cdd9378ab12c58ec883929398`.
The live chat title-edit/restore check remains pending database recovery and the merged agent
follow-up deployment; local test success does not close it.

Production aggregation continuation, 2026-10-14, release `30f585ceb1a811a97c523251ea6bd0bee13fc07f`: after the fictional COP 1 `PRUEBA QA AUDITORIA 20261014` expense was captured and categorized as Restaurantes, the recent-Transaction Widget displayed its name, Category and 14 October date. The monthly metric showed COP 0 income and COP 1 expenses, matching Transactions and the uncapped Budget summary. The Category chart included Restaurantes, while the Budget Widget correctly retained its no-cap state. After action-time approval and fixture deletion, returning to Dashboard showed no Category series, no recent Transactions and no monthly Transactions to calculate. This closes live cross-view read-after-delete for this fixture. No Widget definition changed.

Rebased audit, 2026-10-14, baseline `a387f50fb5`: the actual Core/D1 browser title editor journey passed again, persisting the canonical title through reload. The two actual Budget Widget journeys also passed, including canonical cap changes/deletion and display-Currency isolation. Production chat title editing still failed before tool execution on that baseline; the Agent feature records its diagnosis and pending repair verification.

Broad non-AI audit, 2026-10-12, baseline `9aafe8db54`: all 449 web checks, 427 Core checks, 302 selected Transaction/Dashboard/HostedTurn Worker/D1 checks, and 99 ordinary browser checks passed. Dashboard browser journeys covered initialization refusals, real Core/D1 rename/removal/resize/placement persistence, mobile stacking, keyboard cancellation and recovery from a committed edit with lost acknowledgment. Delayed/refused transport journeys use controlled responses; they do not establish live failure rates. Production release `6863b80f2a` displayed four empty Widgets consistently with empty Transaction history. At 390px they stacked in canonical order with no document overflow; mobile navigation worked and the viewport was restored. No production Dashboard edit was submitted. The newer trunk commit changes only the public landing CLI instructions; its 25 focused web checks passed after synchronization.

Capability and verification map for `/app/dashboard`. This records implementation evidence, not a replacement for GitHub product requirements.

## Behaviour

| Capability        | Implemented behaviour                                                                                                                                                                                                             | Evidence                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| First use         | Read the canonical view. Only `DashboardUninitialized` permits explicit initialization, followed by one fresh read. Unavailability never means absence or triggers recursive initialization.                                      | `query.ts`, rendered route checks, and seven built-browser loading scenarios.                                        |
| Financial results | Four Widget variants render spending buckets, budget availability, Transaction lists, and custom metrics. Server-calculated periods and currency groups remain authoritative. Missing or malformed data is not invented as Money. | Presentation tests, Core calculation/aggregation tests, and schema-decoded view.                                     |
| Money             | Display uses authoritative decimal text, including values beyond safe binary-number precision. Charts use bounded dimensionless geometry without replacing Money with floating-point amounts.                                     | Six exact-Money presentation checks.                                                                                 |
| Layout            | The canonical recursive layout controls desktop axes and relative shares. Mobile stacks in canonical reading order.                                                                                                               | Responsive presentation and layout rule checks.                                                                      |
| Personalization   | “Personalizar” reveals catalog drag sources, named keyboard destinations, Dashboard and Widget title controls, Widget removal, and boundary resizing. Gestures compile to canonical edits.                                        | Drag adapter, editor model, rendered feature, and command checks.                                                    |
| Saving            | Each gesture sends its edit immediately through a serialized queue. “Guardar” exits editing; it does not commit a separate unsaved document. Successful edits invalidate the canonical view.                                      | `editing.ts` and generated-transport lifecycle checks.                                                               |
| Failure recovery  | Rejected edits and uncertain outcomes have different copy. A successful save followed by failed refresh retains the prior canvas and reports stale evidence. Catalog and view retries have independent ownership.                 | Rendered feature and edit-lifecycle tests.                                                                           |
| Dashboard title   | “Personalizar” reveals a pencil beside the canonical heading. The inline editor trims a non-empty title of up to 80 characters, saves through `set-title`, and cancels with Escape or its cancel button.                          | Rendered regression, real local Worker/D1, built-browser read-after-edit, and Production edit/reload/restore passed. |

## Owners

- `feature.tsx` owns independent query feedback.
- `editing.ts` owns the mounted edit queue, pending placement, canonical reread and recovery; presentation receives projected placement rather than canonical edit internals.
- `query.ts` owns read/initialize/read and its workflow phase.
- `editor-model.ts` translates closed UI gestures to canonical edits.
- `drag-adapter.tsx` owns drag transport validation and semantic destinations.
- `view.tsx`, `presentation.ts`, and Money presentation own rendering.
- Server Core Dashboard owns the document grammar, edit rules, periods, aggregation, and authoritative results. Cloudflare adapters own admitted persistence and execution.

## Placement feedback

Dragging keeps the confirmed layout still and highlights the chosen destination in green with its placement label. Mouse/pen drags require eight pixels of movement; touch retains its hold-to-drag constraint. The resulting arrangement appears only after dropping. A catalog Widget shows a placeholder until Core calculates its results.

Dropping shows the placement immediately and announces “Guardando cambio…”. Editing stays disabled until the canonical reread completes. Refused or uncertain edits and failed rereads restore the last confirmed arrangement; an uncertain edit is never automatically replayed. The preview is transient presentation state, not another persisted Dashboard document.

`dashboard-editing.spec.ts` checks delayed saves, delayed and failed rereads, lost acknowledgment, and keyboard cancellation through the built browser. `dashboard-core.spec.ts` checks stable hover geometry and persisted edits through public Ingress, private Core, and local D1. Missing Widgets offer an explicit canonical refresh rather than a generic validation error.

Uncertain outcomes and missing Widgets discard unsent edits and block further submission until an explicit successful canonical refresh. A failed refresh keeps that block. Leaving the mounted Dashboard discards unsent edits and suppresses late local feedback; an already-sent mutation may have committed and is never automatically replayed. The removed `editing.test.tsx` suite supplied historical rendered evidence for these rules. Current mounted editing checks run through the Dashboard browser journeys below.

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

The seven initial-load built-browser scenarios intercept API responses. They verify the built UI and request sequence, not production financial results. The separate Worker/D1 suite exercises actual local persistence and admitted execution.

The remaining-check rerun on 2026-10-12 passed **70 Core checks**, **71 local Worker/D1 checks**, and **9 loading/title/customization browser checks**. All **6 editing browser checks** also passed, including a new mobile touch-input check: a brief touch leaves dragging inactive, holding activates it, and cancellation sends no edit. This uses emulated Chromium touch input against the built UI with HTTP response fixtures, not a physical phone or live persistence.

Production revision `52f83b8d096eb86d79769ea47370f68c1148d1c8` (the same runtime as PR #1237) passed Widget rename and keyboard resize followed by reload. The original name and shares were restored and verified after another reload. Keyboard drag/Escape canceled visibly. At a 390 × 844 viewport, all four Widgets stacked in canonical order with no horizontal document overflow; mobile navigation to Transactions and back retained the Dashboard. No browser console warnings or errors were observed. Deployment metadata matched the tested revision.

## Historical Production evidence and remaining checks

- [Issue #1214](https://github.com/B4rz99/fidy-ai/issues/1214): canonical title was ignored by the web heading. The focused regression reproduced it, then all **45 web feature checks** and **24 application checks** passed after rendering `view.title`. The real local browser edit/reload check also passed. The fix merged in [PR #1216](https://github.com/B4rz99/fidy-ai/pull/1216). Production revision `1756c9e9fdaafe02a33a072d34bc058da1ddd043` passed canonical title editing on 2026-10-12: an explicitly approved seven-day PAT with `read` and `dashboard` scopes changed `Tablero` to `Tablero QA verificado`; a full browser reload displayed that heading. Restoring `Tablero` through the same operation and reloading restored the original heading. No browser console warnings or errors were observed. At that revision, the UI had no Dashboard-title edit control.
- In that same Production check, the approved account initially returned `dashboard_uninitialized`. Opening its Dashboard initialized the four default Widgets; a subsequent canonical read succeeded. This verifies initialization for an already signed-in User, not a fresh signup journey.
- Real admitted Dashboard initialization/edit/read, ownership refusals, and retained Audit evidence passed the local Worker/D1 suite; repeat production behaviour separately.
- Earlier Production checks on 2026-10-11, before the React restoration in PR #1233, verified the original four Widgets, ten recent Transactions, separate Money directions, and explicit missing Budget. Rename, keyboard resize, pointer swap/edge movement, keyboard cancellation, catalog insertion and approved removal survived reload; original identities, order and weights were restored. These are historical release observations, not verification of the current React placement fix.
- Production revision `72ddd85d9a73487a7f0f0e457700225012d718f4` verified disposable funded Budget fixtures: `1600` COP spent against caps `2000`, `1600` and `1500`. A `12.34` USD Transaction appeared separately from COP in the list, chart and metric. Fixtures were removed through canonical operations; the Dashboard matched its baseline except calculation time, and browser reload confirmed cleanup.
- First use with a fresh approved Production User and physical touch gestures remain unverified live. Local negative tests cover ownership, withdrawal of Consent and failure recovery; failures were not induced in Production.
- Production monthly totals matched the complete retained Transaction history before and after the approved three-fixture cleanup below. Direct production Audit/SourceAttestation retention passed the bounded read-only storage observation below.

```sh
bun run --cwd apps/web test src/features/dashboard
bun run --cwd apps/server test:core src/core/dashboard --coverage.enabled=false
bun run --cwd apps/web test:browser dashboard-queries.spec.ts --workers=1
bun run --cwd apps/web test:browser dashboard-editing.spec.ts --workers=1
BROWSER_COST_MEASUREMENT=1 bun run --cwd apps/web test:browser dashboard-live-customization.spec.ts --workers=1 --timeout=120000
bun run --cwd apps/server test:cloudflare cloudflare/dashboard --maxWorkers=1
```

Production aggregation observation, 2026-10-12, React release `274f64ecdb1ff2d2997ecc52202d9e446e361653`: the monthly metric displayed COP 2,500 income and COP 6,387 spending. Transactions showed COP 2,931 spending for the first 100 loaded records, then loaded the remaining COP 3,456 test record. The complete-history sum matches the Dashboard spending metric. This is live aggregation evidence with existing fixtures; it does not establish canonical-title editing, source/Audit retention after deletion, or every Widget variant.

Production cleanup verification, 2026-10-12, release `804b122e7f68eec439f165b42cf99b6aedff99f1`: after the three explicitly approved chat fixtures were deleted through exact hosted challenges, reloaded Transactions showed 99 retained rows, COP 2,500 income and COP 1,697 spending, with all three deleted names absent. Dashboard monthly income/spending matched those values. Only those three fixtures were deleted; the other labelled fixtures remain. Production retained Audit/SourceAttestation storage was not inspected.

Production retention observation, 2026-10-12: a bounded read-only D1 query addressed only the three approved chat-fixture Transaction identities. Each retained Transaction had a deletion marker and exactly one retained SourceAttestation. The owning User had three successful `transactions.deleteTransaction` Audit entries in the checked 2026-10-12 UTC window. Audit has no per-Transaction reference, so the aggregate count does not independently attribute each entry to a fixture. D1 reported zero writes. No raw attestation contents, credentials or unrelated financial records were queried. Together with the exact hosted deletion receipts and the reloaded History/Dashboard observations, this establishes retained capture evidence and aggregate deletion accountability for this cleanup.

Production canonical-title observation, 2026-10-12, on the currently signed-in User: an explicit `dashboard.applyDashboardEdit` request with `payload: {op: "set-title", title: "Tablero QA temporal 20261012"}` produced an exact host challenge. Confirmation completed the operation, and browser reload displayed that heading. A second exact edit restored `Tablero`, also verified after reload. No Transaction or Budget change was requested. This closes canonical title persistence for this User, independently of the earlier audit User's totals.

The natural-language title request failed twice with HTTP 503 and `{status: "unavailable"}`, then reached a valid host challenge on a later retry. The successful greeting and Dashboard title query, and retained successful `dashboard.getDashboard` evidence within one failed Turn, do not establish the cause of those failures. Read-only metadata recorded `HostedInferenceFailed`; malformed tool arguments, provider failure, and other inference failures remain distinguishable only with additional bounded diagnosis. The later challenge was not confirmed. An independent Widget title change was also observed during this period, so this run does not establish an isolated unchanged-Widget baseline. The intermittent chat failure remains open.

After the User reported switching accounts on 2026-10-12, Transactions displayed zero records and the Dashboard displayed its four empty default Widgets. The same ordinary-language title request failed twice, while a greeting and title query passed. Exact canonical arguments again allowed title editing, reload verification and restoration to `Tablero`. All four empty Widgets remained visible after restoration. Accesos later displayed a Dashboard test token created outside this audit; this observation does not establish exclusive use of the account or a fresh-signup initialization journey.

Dashboard title editor, local evidence 2026-10-13: the visible pencil and inline editor now submit through the existing canonical edit queue. The real Core/D1 built-browser check saved a trimmed title and verified it after reload. Controlled browser checks verified blank-title refusal, the 80-character input limit, draft cancellation and keyboard focus restoration. All 9 selected title/editing/Widget-customization browser checks and 18 Dashboard unit checks passed. These results do not establish a Production deployment of the new control.

Production chat retest, 2026-10-14, release `c9bdf41e721d9d88f93d83ff1f7e9a526d1fd2d5`: after an explicit canonical Dashboard read, a natural-language Widget rename produced an exact host challenge. Confirmation, reload and a second chat edit restored “Salidas del mes”, including its original label, aggregation and period. Reload verified restoration. Direct rename without the explicit read still failed before canonical execution; this is successful canonical persistence through chat, not closure of the natural-language discovery failure. No Transaction or Budget changed.
