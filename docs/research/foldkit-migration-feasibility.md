# Foldkit migration feasibility

_Research snapshot: 2026-10-10. Assessment only; no migration or dependency installation._

## Assessment

Fidy could migrate its web application to Foldkit. The main cost is rewriting presentation and state ownership, not changing the server. A small representative prototype is the useful next step before choosing a complete rewrite. This recommendation is an inference from the current web architecture and the framework's documented programming model, not a measured migration estimate. [Fidy web architecture](../../apps/web/ARCHITECTURE.md), [Coming from React](https://foldkit.dev/react/coming-from-react).

## Verified framework facts

- Foldkit uses The Elm Architecture: Schema-defined Model, typed Messages, an update function, and HTML builder views. Commands execute Effect work; Subscriptions manage external event streams. JSX and React hooks require translation into that architecture. [React comparison](https://foldkit.dev/react/coming-from-react).
- The inspected `foldkit` manifest is version `0.167.0` and pins peer dependencies `effect: 4.0.0` and `@effect/platform-browser: 4.0.0`. Fidy already pins Effect `4.0.0`; there is no evident major-version mismatch. This is manifest compatibility, not an integration test. [Foldkit manifest](https://raw.githubusercontent.com/foldkit/foldkit/main/packages/foldkit/package.json), [Fidy web manifest](../../apps/web/package.json).
- The project calls itself beta and warns that minor releases can contain breaking changes. Its homepage identifies it as pre-1.0. [Repository README](https://github.com/foldkit/foldkit), [project status](https://foldkit.dev/).
- Foldkit includes typed bidirectional routing, browser lifecycle primitives, and Story/Scene testing. Its existing React integration uses `Runtime.embed`, Schema-typed Ports, and host-owned disposal. An embedded `makeElement` program can leave document and URL ownership with React. This supports an isolated pilot rather than requiring an immediate whole-app cutover. [Homepage](https://foldkit.dev/), [embedding](https://foldkit.dev/core/embedding).
- `@foldkit/ui` supplies headless accessible primitives with consumer-owned markup and styles. The documented catalog includes dialogs, menus, comboboxes, calendars/date pickers, toast, virtual lists, and drag/drop with keyboard navigation and screen reader announcements. This is useful coverage, but does not demonstrate parity with Fidy's particular interactions or independently validate accessibility. [UI catalog](https://foldkit.dev/ui/overview).
- Foldkit and React plus Effect Atom differ in state ownership: Foldkit owns rendering and the runtime and routes updates through one Model/Message flow, with Submodels for composition. Existing Atom-backed workflows are therefore adaptation work even though Effect services and schemas are familiar. [Official Effect Atom comparison](https://foldkit.dev/react/foldkit-vs-react-effect-atom).

## Fidy-specific migration boundary

The current app explicitly assigns shared/server state to Effect Atom, URL state to TanStack Router, and local interaction state to React. A complete migration would change that documented decision and rewrite React views and their bindings. React-specific dependencies include Base UI/shadcn, TanStack Table/Router, Recharts, dnd-kit React, React Day Picker, Hugeicons React, and Sonner. Foldkit alternatives cover some capabilities, but no drop-in compatibility has been established. CSS, assets, pure helpers, and server-owned browser contracts are the strongest reuse candidates. [Web architecture](../../apps/web/ARCHITECTURE.md), [web dependencies](../../apps/web/package.json).

The backend boundary should remain the browser-safe `@fidy/server/client` seam with its existing HTTP policy. Static browser delivery remains compatible in principle; adopting server rendering is unnecessary and would reopen the assets-only hosting decision. [Web architecture](../../apps/web/ARCHITECTURE.md), [ADR 0026](../adr/0026-cloudflare-native-production-replatform.md).

A migration must preserve authentication-lifetime disposal and secret ownership. Fidy intentionally keeps payment OTPs, provider authorization handles, private pairing proofs, and other transient authority out of shared state, storage, and URLs. Foldkit's inspectable Model and Message history make naive translation of every React field into the global Model inappropriate. The prototype should demonstrate private scoped resources and cleanup before migrating authentication/payment flows. This is a design requirement inferred from Fidy's existing invariants, not a claim that Foldkit cannot meet them. [Web architecture](../../apps/web/ARCHITECTURE.md), [payment enrollment ADR](../adr/0021-browser-only-payment-credential-enrollment.md), [Foldkit DevTools overview](https://foldkit.dev/).

## Suggested decision experiment

Prototype one ordinary feature with a canonical read, a mutation, loading/refresh/error behavior, a dialog, and route integration. Use the existing API contract and policy. Check keyboard and screen reader behavior, cleanup on authentication replacement, bundle output, and equivalent browser journeys. Only then estimate the full rewrite and compare the concrete benefits against the already Effect-based React frontend.

No prototype, package installation, performance benchmark, production suitability audit, or compatibility test was performed for this assessment. Source links to `main` and live documentation are mutable snapshots.
