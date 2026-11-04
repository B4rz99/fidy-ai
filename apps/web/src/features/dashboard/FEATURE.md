# Dashboard

The `/app/dashboard` capability follows the canonical Dashboard document and projection owners.
Product requirements and dated verification evidence belong to GitHub issues and PRs; this document
records durable behavior and repeatable verification seams. The current read lifecycle is specified
in [#1847](https://github.com/B4rz99/fidy-ai/issues/1847), with observed-revision edits in
[#1848](https://github.com/B4rz99/fidy-ai/issues/1848).

## Reads and first use

Direct entry returns a complete escaped, no-store financial document through the Web Worker,
public Ingress and existing guarded canonical read. The document's cookie-derived binding must
match the authenticated browser lifetime before its one-use initial transfer is consumed. Ordinary
in-app entry obtains the same representation as an HTML fragment. Every mounted visit owns a fresh
query; retained financial display and superseded responses cannot satisfy a later visit.

The read-only path renders all four Widget variants: spending charts, Budget availability/progress,
recent Transactions and custom metrics. Server-calculated periods, Category labels and Currency
groups remain authoritative. Money stays exact decimal text, including amounts beyond safe binary
precision; chart/progress numbers represent only bounded dimensionless geometry. The canonical
recursive layout controls desktop axes and relative shares; mobile stacks in canonical order.
Transactions link to their local calendar day. User-controlled text is escaped before HTML emission.

An absent document offers **Crear tablero**. Only that explicit gesture calls initialization;
unavailability never means absence. Pending feedback is minimal. Failed reads expose Retry and
withhold stale financial content. The canonical structured endpoint remains available to editors,
CLI, MCP and other clients; HTML is a representation, not another financial authority.

**Personalizar** enters the validated `customize=1` route and loads the structured snapshot and Widget
catalog. The catalog is not part of an ordinary read. Editor reads revalidate on focus and mount
without restoring implicit initialization or retaining financial HTML.

## Editing and recovery

Each accepted gesture submits one immediate canonical mutation; there is no queue of unsent edits.
**Guardar** exits editing, rather than committing a separate local document. A mutation carries the
observed `expectedRevision`; Core compares it with the persisted document revision. Form drafts keep
the revision observed when opened, even if another read or tab advances the document. A conflict
cannot silently overwrite another tab's change and requires an explicit refresh and review.

The mounted edit owner tracks an in-flight gesture, transient placement feedback and canonical
reread recovery. Dragging leaves confirmed geometry still and highlights the semantic destination;
mouse/pen drags require eight pixels of movement, while touch uses its hold constraint. Dropping
shows a transient placement and **Guardando cambio…** while the canonical result is obtained.
Further edits remain disabled until recovery completes. This preview is not a persisted document.

Rejected and uncertain mutation outcomes have distinct feedback. An uncertain mutation is never
automatically replayed. Missing Widgets and revision conflicts require an explicit successful refresh
before more edits. Route departure discards local unsent gestures and suppresses late feedback; an
already-sent mutation may have committed. Failed refreshes withhold the financial canvas while
keeping the structured editor mounted, preserving unsaved title and Widget configuration drafts.
Catalog and financial read retries retain independent ownership.

Dashboard titles trim non-empty text up to 80 characters. Escape or Cancel closes a draft without
submission and restores focus. Budget configuration uses the selected Widget identity, existing
Category/Currency and its draft revision; choices load only when opened. Unavailable or refreshing
choices cannot be saved. Missing Budget targets retain their Category/Currency and offer explicit
selection or Budget creation.

## Owners and verification

- `html-feature.tsx` and `html-query.ts` own ordinary HTML reads, explicit creation and Retry.
- `initial-dashboard.ts` owns the one-use binding-matched document transfer.
- `feature.tsx` and `query.ts` own structured editor feedback and focus revalidation.
- `editing.ts` owns immediate mutation submission, observed revisions, pending placement and recovery.
- `editor-model.ts` translates closed gestures; `drag-adapter.tsx` validates drag transport and destinations.
- `view.tsx`, `budget-configuration.tsx` and `presentation.ts` own editor presentation and draft lifetime.
- Server Core owns document grammar, edits and financial interpretation. The shell composes complete
  owner facts and renders HTML; Cloudflare adapters own guarded persistence, admission and execution.

`dashboard-html.spec.ts` exercises actual native document/fragment entry, explicit initialization,
catalog deferral, refusal withholding, Retry and a held superseded response. It retains desktop,
mobile, dark and Customize captures under ignored `reports/design` for Design review.
`dashboard-core.spec.ts` verifies persisted public edits and placement; `dashboard-live-title.spec.ts`
verifies cross-tab revision conflicts and failed-refresh draft preservation. Controlled editor and
query journeys distinguish delayed responses, refusals and lost acknowledgments from native
persistence evidence. Native Dashboard tests retain ownership, authorization, exact Money, Audit,
recovery and canonical contract checks. These checks do not establish production availability or
performance targets.

```sh
bun run --cwd apps/web test src/features/dashboard
bun run --cwd apps/server test:core src/core/dashboard --coverage.enabled=false
CLI_ACCEPTANCE_MODE=dashboard bun --cwd apps/web --bun playwright test --config playwright.dashboard.config.ts
bun run --cwd apps/web test:browser dashboard-live-title.spec.ts --workers=1
bun run --cwd apps/web test:browser dashboard-editing.spec.ts --workers=1
bun run --cwd apps/server test:cloudflare cloudflare/dashboard --maxWorkers=1
```

Check native topology port ownership before running browser journeys. Independent cold-document
and return-fragment measurement, clock/probe limits and ignored artifact handling are documented in
[`docs/operations/dashboard-performance.md`](../../../../../docs/operations/dashboard-performance.md).
The Web and Server architecture documents own the same-origin proxy, cookie and guarded-read boundaries.
