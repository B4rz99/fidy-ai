# Dashboard

Capability and verification map for `/app/dashboard`. This records implementation evidence, not a replacement for GitHub product requirements.

## Behaviour

| Capability        | Implemented behaviour                                                                                                                                                                                                             | Evidence                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| First use         | Read the canonical view. Only `DashboardUninitialized` permits explicit initialization, followed by one fresh read. Unavailability never means absence or triggers recursive initialization.                                      | `query.ts`, rendered route checks, and seven built-browser loading scenarios.                                            |
| Financial results | Four Widget variants render spending buckets, budget availability, Transaction lists, and custom metrics. Server-calculated periods and currency groups remain authoritative. Missing or malformed data is not invented as Money. | Presentation tests, Core calculation/aggregation tests, and schema-decoded view.                                         |
| Money             | Display uses authoritative decimal text, including values beyond safe binary-number precision. Charts use bounded dimensionless geometry without replacing Money with floating-point amounts.                                     | Six exact-Money presentation checks.                                                                                     |
| Layout            | The canonical recursive layout controls desktop axes and relative shares. Mobile stacks in canonical reading order.                                                                                                               | Responsive presentation and layout rule checks.                                                                          |
| Personalization   | “Personalizar” reveals catalog drag sources, named keyboard destinations, Widget title/removal controls, and boundary resizing. Gestures compile to canonical edits.                                                              | Drag adapter, editor model, rendered feature, and command checks.                                                        |
| Saving            | Each gesture sends its edit immediately through a serialized queue. “Guardar” exits editing; it does not commit a separate unsaved document. Successful edits invalidate the canonical view.                                      | `feature.tsx` and queued-command checks.                                                                                 |
| Failure recovery  | Rejected edits and uncertain outcomes have different copy. A successful save followed by failed refresh retains the prior canvas and reports stale evidence. Catalog and view retries have independent ownership.                 | Feature/controller tests.                                                                                                |
| Dashboard title   | The server supports `set-title` and returns the resulting User-visible title. The development heading now renders that canonical value with the existing typography.                                                              | A new rendered regression failed before the fix and passed after it; release and production verification remain pending. |

## Owners

- `feature.tsx` owns independent query feedback and serialized canonical edits.
- `query.ts` owns read/initialize/read and its workflow phase.
- `editor-model.ts` translates closed UI gestures to canonical edits.
- `drag-adapter.tsx` owns drag transport validation and semantic destinations.
- `view.tsx`, `presentation.ts`, and Money presentation own rendering.
- Server Core Dashboard owns the document grammar, edit rules, periods, aggregation, and authoritative results. Cloudflare adapters own admitted persistence and execution.

## Verification

On 2026-10-11, audited release checkout based on `a2483f5dd1939fc3c3a37887c4e93c8081893666` passed:

- **44** web feature checks across seven files.
- **70** Core checks across six files.
- **7** built-browser initial-load scenarios: fresh/existing, denied/failed initialization, failed/absent second read, and failed initial read.
- **71** actual local Worker/D1 checks: admitted Dashboard operations, ownership refusals, persistence and retained evidence.

The built-browser scenarios intercept API responses. They verify the built UI and request sequence, not production financial results. The separate Worker/D1 suite exercises actual local persistence and admitted execution. This document is an audit artifact in the development checkout, not evidence that this checkout has been deployed.

## Open audit findings and remaining checks

- [Issue #1214](https://github.com/B4rz99/fidy-ai/issues/1214): canonical title was ignored by the web heading. The focused regression reproduced it, then all **45 web feature checks** and **24 application checks** passed after rendering `view.title`. The fix is prepared on its task branch; production verification remains pending.
- Real admitted Dashboard initialization/edit/read, ownership refusals, and retained Audit evidence passed the local Worker/D1 suite; repeat production behaviour separately.
- Verify browser customization against a real local server, including keyboard add/move/resize, rejected/uncertain edits, and read-after-save.
- Production totals and read-after-delete remain pending the chat release and provider availability. Use only this chat's labelled fixtures.

```sh
bun run --cwd apps/web test src/features/dashboard
bun run --cwd apps/server test:core src/core/dashboard --coverage.enabled=false
bun run --cwd apps/web test:browser dashboard-queries.spec.ts --workers=1
bun run --cwd apps/server test:cloudflare cloudflare/dashboard --maxWorkers=1
```
