# Frontend polish

First pass: 2026-10-09. This is an implementation-backed audit of manual Transaction capture
and current-month history, plus the starting application UI reference. It is not a completed
usability study; visual browser checks are recorded separately below.

## Review the shared foundation

Run `bun run dev:web` and open `/ui-reference.html`. The separate development entry composes
the actual application primitives and tokens; it has no API client, authentication state, or
financial mutations. The production Vite build continues to use only `index.html`.

The reference includes Light, Dark, and System previews, semantic pastel feedback, primary and
secondary actions, input guidance and errors, a Transaction row, and distinct empty/loading
states. Example data is labeled. The reference's appearance choice is local to that preview.
Persisted application-wide theme selection remains follow-up work; the public site's existing
theme preference is independent.

If the local Bun launcher runs Vite under Node and reports `Bun is not defined`, run
`bun ../../node_modules/vite/bin/vite.js` from `apps/web` instead.

Grafito is the selected dark palette for the app and landing: neutral charcoal surfaces,
readable warm text, and green/pastel accents. The landing's temporary palette selector was
removed after selection. The UI reference retains the comparison alternatives and defaults
to Grafito. The hero, phone, and chat use the approved neutral surfaces.

Shared styles now apply the documented Poppins family, warm light and Grafito dark palettes,
green primary actions, pastel feedback with dark text, and 44–48px main controls. Compact explicit
button sizes remain available. Fonts and their license live under `apps/web/src/ui/fonts/`.
Input borders use the darker documented neutral for visible control boundaries; the structural
border stays subtle. Financial formatting continues to use the existing exact-decimal formatter.

## Transaction journey audit

Sources: `apps/web/src/features/transactions/manual-capture.tsx`, `feature.tsx`,
`presentation.ts`, their behavior tests, and `apps/web/e2e/financial-journeys.spec.ts`.

| Existing behavior                                                                                            | Recommended next change                                                                                                     | Why                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture appears before the history page heading, outside its constrained main layout.                        | Give capture, saved feedback, and history one clear page composition with one main landmark.                                | Users should understand the page before encountering its form; mobile alignment should stay consistent.                                                          |
| Amount has no example or explanation of accepted decimal/grouping syntax.                                    | Define Colombian amount entry, show an example, and add field-level validation.                                             | The exact-decimal parser currently expects machine decimal text; familiar `28.000` could mean 28 instead of 28,000. Formatting must never silently change Money. |
| Amount/date validation and declared refusals produce one generic retry message.                              | Distinguish correctable input errors from resource refusal; associate errors with fields.                                   | Repeating unchanged invalid input cannot fix it. Preserve drafts and the server's failure meaning.                                                               |
| The form has no Category choice; capture supplies no CategoryId and lets the canonical operation categorize. | Expose a Category choice from the already-loaded canonical list, while preserving automatic categorization when unselected. | Users should be able to choose the classification without inventing client-owned Category identities.                                                            |
| Labels say “Dirección”, “Salida”, “Entrada”, and “Contraparte”.                                              | Use “Tipo de transacción”, “Gasto”, and “Ingreso”; explain Contraparte using person/business examples.                      | Match the history labels and make domain terms understandable without changing their meaning.                                                                    |
| Save waits for canonical success, clears only amount/counterparty, and refreshes history.                    | Keep this sequencing; announce a stable success message with the confirmed result.                                          | Successful capture must remain separate from a later history-refresh failure.                                                                                    |
| An uncertain save keeps the draft, blocks another save, and offers history refresh.                          | Preserve this guard; explain how to identify the possibly saved Transaction and recover safely.                             | Blind retry can create another Transaction. Do not automatically unlock submission after a read.                                                                 |
| Empty history explains that Transactions will appear but gives no relevant next step.                        | Point to the manual capture form using a focused action or in-page link.                                                    | First use needs direction, not only an explanation of absence.                                                                                                   |
| Desktop history and mobile cards use exact Money, Category identity, dates, and Gasto/Ingreso labels.        | Keep exact formatting; add explicit direction signs where useful and check wrapped names/amounts at narrow widths.          | Financial meaning must survive wrapping, zoom, and color changes.                                                                                                |
| Saved preview omits Category and direction.                                                                  | Show the confirmed classification and Gasto/Ingreso alongside Money and date.                                               | Users need to verify what was recorded, not only that something saved.                                                                                           |
| History has no Correction action.                                                                            | Design a review-and-correct flow against the existing canonical Correction operation and its revision rules.                | Completing the journey requires correcting the same Transaction, never silently creating another.                                                                |

## Implementation order

1. Review the UI reference at 390px, 715px, and 1440px in both themes, with keyboard focus and
   enlarged text. Approve component treatments before extending them across all screens.
2. Polish capture/history composition and copy; add unambiguous amount entry and Category selection.
   Keep success, declared refusal, uncertainty, loading, empty, and stale history distinct.
3. Add Correction review and conflict handling; test the public user journey through canonical clients.
4. Reuse approved patterns for Budgets, hallazgos, and account settings.

## Enforcement

`@shadcn/lint` runs inside the existing root Oxlint config through `bun run lint` and
`bun run lint:type-aware`; CI's static verification already invokes the latter.

- `no-raw-colors` encourages declared theme colors, including inside shared primitives.
- `no-arbitrary-values` checks application appearance while allowing layout values; primitives
  own their structural styling.
- `no-restyle` requires approved component variants and sizes. Content containers may control
  spacing; table cells, Card titles/actions may control typography; Empty may have a border.
- The old custom design-system script is removed. Blanket `dark:` and `space-*` restrictions
  are no longer lint errors. Black/white follow the upstream rule's accepted defaults.
- `check:shadcn` still checks component-output aliases. Accessibility lint and browser checks
  remain separate. Lint cannot assess clarity of copy or actual foreground/background contrast.

The existing Oxlint integration suite includes positive and negative probes for this policy.
See the upstream [rules](https://github.com/shadcn-ui/lint/blob/main/docs/rules.md) and
[component contracts](https://github.com/shadcn-ui/lint/blob/main/docs/design-systems.md).

## Verification evidence

- Root project-reference typecheck, type-aware Oxlint, real-config design-policy probes,
  formatting, web module graph, shadcn aliases, and browser bundle boundary passed.
- Ten repository-tool tests passed. With the pinned Bun 1.4.3 runtime, all 361 web tests passed
  and Istanbul coverage passed the unchanged thresholds (90.14% branches). The older local
  Bun 1.4.1 launcher had failed two topology discovery tests by executing Bun-dependent code
  under Node; both pass with the pinned runtime.
- Thirteen built-production browser tests passed, covering Transaction capture/history,
  loading and cross-User refusal, static security policy, landing appearance persistence,
  and public-page accessibility. Vite was invoked through its file entry to avoid the launcher issue.
- A further 29 built-browser checks passed for signup, browser pairing, Dashboard editing,
  theme persistence, static security policy, and accessibility. Dashboard title editing reserves
  space for the enlarged icon controls. Appearance checks use the single theme toggle, and
  entrance waits exclude scroll timelines that intentionally remain active while stationary.
- The UI reference had no WCAG A/AA axe findings or horizontal overflow at 390px, 715px,
  and 1440px in Light and Dark. System followed an emulated preference change; keyboard focus
  reached the primary action. At 390px with 200% root text size, the page remained within the viewport.
- The production artifact contains neither the reference HTML nor its JavaScript content.
  The reference remains a separate development entry with labeled example data.
