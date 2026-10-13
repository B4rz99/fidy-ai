# Pattern catalog audit

Research snapshot: 2026-10-12. Scope: all 20 Markdown files in `.patterns/`, the four vendored trees in `.repos/`, selected application consumers, and official React documentation.

## Assessment

The catalog generally promotes sound practices: explicit ownership and resource lifetimes, bounded concurrency and input sizes, typed public failures, authentication-scoped caches, native D1 atomicity, and application-specific security boundaries. It is a useful implementation guide, but it is neither exhaustive API documentation nor consistently a practical recipe catalog. Some entries explain concrete library behavior; others mostly repeat architecture and security policy.

All four repositories are represented. Representation does not establish complete coverage or release parity:

| Repository | Existing coverage                                                                                                                                  | Assessment                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effect     | Core, HTTP, HttpApi, Schema, SQL, workflows, crypto, AI, layers, errors, concurrency, streams, observability, testing, Atom; a separate source map | Broadest coverage. MCP and process execution are important omissions. Several policy-oriented pages need actual API recipes.                                         |
| Alchemy    | `alchemy.md`, source map, platform references elsewhere                                                                                            | Good deployment-topology guidance; limited resource authoring and binding guidance. Vendored package is beta.79; application authority is patched beta.80.           |
| React      | `react.md`, plus Atom integration                                                                                                                  | Good fundamentals, but documented/vendored 19.2.8 differs from application 19.3.0. Async UI and current public API selection need expansion.                         |
| dnd-kit    | `dnd-kit.md`                                                                                                                                       | Detailed guidance for the recursive Dashboard. Useful public observer and sortable APIs are omitted, but sortable is not necessarily appropriate for this Dashboard. |

Sources: [catalog](../../.patterns/INDEX.md), [selected Effect/Alchemy source map](../../.patterns/effect-4-stable.md), [web dependencies](../../apps/web/package.json), [vendored React version](../../.repos/react/packages/react/package.json), [vendored Alchemy version](../../.repos/alchemy/packages/alchemy/package.json), [dnd-kit exports](../../.repos/dnd-kit/packages/react/package.json).

## Corrections and consequential gaps

### 1. Explain native fetch redirects before Effect redirect handling

**Priority: high documentation fix.** `.patterns/http-client.md:51-53` explains `followRedirects` limits and credential stripping, but omits `FetchHttpClient.RequestInit`. In pinned Effect 4.0.1, `src/http/FetchHttpClient.ts:56-79` forwards those options to native fetch and defaults to an empty options object. Native fetch can therefore follow a redirect before Effect's combinator sees the response. A combinator redirect limit alone does not enforce the intended transport policy.

Document `redirect: "manual"` for explicit response handling, or `"error"` when redirects are forbidden, then explain destination validation and the runtime's manual-redirect limitations. The existing [browser policy](../../apps/web/src/transport/browser-http-policy.ts) and [CLI transport](../../apps/cli/src/direct-client/runtime.ts) already configure manual redirects. This is a documentation gap, not a finding that those consumers are vulnerable.

Reproduced against the pinned compiled distribution with a loopback server: `followRedirects(client, 0)` and the default FetchHttpClient returned 200 after requesting both `/start` and `/end`. Providing `FetchHttpClient.RequestInit` with `redirect: "manual"` returned 302 and requested only `/start`.

Primary source: [FetchHttpClient 4.0.1](https://unpkg.com/effect@4.0.1/src/http/FetchHttpClient.ts), verified against the integrity-locked tarball; [current pattern](../../.patterns/http-client.md).

### 2. Repair React source-version drift

**Priority: high maintenance fix.** `.patterns/INDEX.md:9` and `.patterns/react.md:3` identify React 19.2.8; `.repos/react/packages/react/package.json` agrees. However, `apps/web/package.json:37-39,54-55` pins React, React DOM, and their types to 19.3.0. The installed-public-contract caveat is good, but the catalog needs the same explicit snapshot-versus-application distinction it already provides for Effect and Alchemy.

Refresh the React reference to the selected release, or clearly label 19.2.8 as historical and identify the 19.3.0 verification source. Do not change a version label while retaining unverified implementation citations.

Sources: [React pattern](../../.patterns/react.md), [index](../../.patterns/INDEX.md), [application manifest](../../apps/web/package.json), [vendored manifest](../../.repos/react/packages/react/package.json).

### 3. Qualify React effect guidance with repository policy and actual lifecycle semantics

**Priority: medium correction.** `.patterns/react.md:27-35` recommends effects for synchronization, then says every setup needs cleanup and production mounts once. General React synchronization guidance is reasonable, but Fidy explicitly restricts direct `useEffect` to narrow adapters with file-scoped lint exceptions. Put that rule beside the recommendation so following the pattern does not lead directly to a repository violation.

Also replace the absolutes: cleanup is required for acquired resources/subscriptions or work needing cancellation, not every idempotent synchronization; production lacks Strict Mode's extra development replay, but cleanup/setup can still recur on changed dependencies, remounts, or Activity visibility changes.

Sources: [coding standards](../../CODING_STANDARDS.md) at lines 282-293; [lint configuration](../../.oxlintrc.json) at line 44 and adapter overrides; [React useEffect reference](https://react.dev/reference/react/useEffect); [Activity lifecycle](https://react.dev/reference/react/Activity).

### 4. Distinguish HTTP tracing from propagation controls

**Priority: medium API gap.** `.patterns/http-client.md:55-59` mentions `TracerDisabledWhen` and `Tracer.DisablePropagation` but omits `HttpClient.TracerPropagationEnabled`. In pinned `src/http/HttpClient.ts:878-880`, `Tracer.DisablePropagation` also bypasses the HTTP client's tracing branch; at lines 923-925, `TracerPropagationEnabled` separately controls trace-header injection.

Add a small decision table: suppress automatic HTTP tracing when its metadata violates policy; independently suppress outgoing trace headers when retaining an approved local span. Do not present the controls as interchangeable. The CLI already uses `HttpClient.TracerPropagationEnabled` in its [transport](../../apps/cli/src/direct-client/runtime.ts).

Primary source: [HttpClient 4.0.1](https://unpkg.com/effect@4.0.1/src/http/HttpClient.ts).

### 5. Make the AI tool-execution switch explicit

**Priority: medium API gap.** `.patterns/ai.md:12-20` correctly assigns the loop and authorization to the application, but does not explain that `LanguageModel` can resolve toolkit calls automatically. Pinned `src/ai/LanguageModel.ts:301-314` exposes both tool-resolution `concurrency` and `disableToolCallResolution`.

Document when the owner must set `disableToolCallResolution: true` to receive calls for its own execution pipeline, versus supplying handlers that already enforce canonical authorization and confirmation. Separately explain `generateText`, `generateObject`, and `streamText` and their bounded result handling. This is guidance for library integration, not a recommendation to replace the current Workers AI adapter.

Sources: [AI pattern](../../.patterns/ai.md), [LanguageModel 4.0.1](https://unpkg.com/effect@4.0.1/src/ai/LanguageModel.ts), [owned inference implementation](../../apps/server/src/shell/hosted-inference/internal/workers-ai.ts).

## Missing API coverage, ordered by practical value

| Addition                           | What to document                                                                                                                                                              | Why it belongs                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effect MCP                         | `McpServer.layerHttp`, `McpSchema`, `McpProtocol`; request context, protocol negotiation, cancellation, elicitation/confirmation and public failure projection                | Already used in [MCP runtime](../../apps/server/cloudflare/mcp/runtime.ts) and [native confirmation](../../apps/server/cloudflare/mcp/native-confirmation.ts), but no MCP entry exists in the pattern catalog. Keep OAuth/confirmation authority in existing owners.                                                              |
| Effect process boundaries          | `ChildProcess.make`, `ChildProcessSpawner`, scoped lifetime, timeout/termination, bounded output, argument arrays and credential handling                                     | Already used by [browser handoff](../../apps/cli/src/login/browser.ts) and [support recovery](../../apps/cli/src/support-recovery/internal/access.ts). The source map names the namespace but there is no usable pattern.                                                                                                         |
| HttpApi recipes                    | `HttpApiMiddleware.Service`, `requiredForClient`, `provides`/`requires`, `layerClient`, `layerSchemaErrorTransform`, policy-bearing client construction and `OpenApi.fromApi` | [http-api.md](../../.patterns/http-api.md) is mostly ownership prose. The [authorization contract](../../apps/server/src/shell/authorization/contract.ts), [authorization runtime](../../apps/server/src/shell/authorization/runtime.ts), and [CLI client](../../apps/cli/src/direct-client/runtime.ts) provide project examples. |
| React async UI                     | `lazy` + `Suspense`, error-boundary placement/reset, `useTransition`/`useDeferredValue`, stable `useId`; distinguish loading from failures                                    | [Routes already use lazy/Suspense](../../apps/web/src/app/routes.ts), and Atom can throw failures into an error boundary. Existing coverage does not explain the complete composition.                                                                                                                                            |
| Alchemy resources and dependencies | Stable logical resource identity, output-dependent inputs; D1, R2, Queue/Consumer/dead-letter settings, Durable Object/Workflow bindings, secret inputs                       | [The stack](../../infra/cloudflare/alchemy.run.ts) already declares these. The current Alchemy pattern mainly documents deployment state, Worker exposure, assets and release receipts. Verify recipes against patched beta.80, not the beta.79 subtree.                                                                          |
| Observability recipes              | `Logger.make`/`Logger.layer`, logger replacement versus merging, `Metric.counter`/`histogram`, bounded attributes, duration recording, flush/finalization                     | [observability.md](../../.patterns/observability.md) explains policy but gives almost no executable library guidance. Show only examples compatible with the existing metadata-only contract.                                                                                                                                     |
| dnd-kit observer APIs              | `useDragOperation`, `useDragDropMonitor`, restricted use of `useDragDropManager`; explain event subscription cleanup and avoiding copied drag state                           | These are [public exports](../../.repos/dnd-kit/packages/react/src/core/index.ts), useful when feedback or event listeners live below the provider.                                                                                                                                                                               |

These are documentation omissions, not evidence that the application needs a new dependency or a rewritten implementation.

## Optional APIs, not immediate requirements

- React `Activity` and `useEffectEvent` deserve short availability/selection notes after aligning the source version. `useEffectEvent` belongs inside the permitted synchronization adapter and must not be used to conceal reactive dependencies. Sources: [Activity](https://react.dev/reference/react/Activity), [useEffectEvent](https://react.dev/reference/react/useEffectEvent), and [vendored client exports](../../.repos/react/packages/react/src/ReactClient.js).
- React `useActionState`, `useOptimistic`, and form APIs can be useful, but must not become a second owner alongside Effect Atom or override the Dashboard's committed-state policy. Their absence is not itself a defect.
- dnd-kit [`useSortable`](../../.repos/dnd-kit/packages/react/src/sortable/index.ts) is a real public API. Add a short “linear sorting versus recursive layout” decision note; do not migrate the recursive Dashboard merely to use it. The current pattern's accessibility, default-sensor preservation, semantic IDs, collision priority, cancellation, and geometry testing guidance is valuable.
- Effect cache/request batching and additional collections can get targeted notes when an actual owner needs them. RPC, a second workflow engine, unused database drivers, and all of Alchemy's other providers do not need catalog coverage simply because their source is vendored.

## Catalog maintenance

Use a consistent short template: when to use; public imports; one minimal recipe or a precise existing implementation link; failure/lifetime/size behavior; testing seam; selected package version and source symbols. Keep Fidy policy visibly distinct from library behavior.

Add a source manifest for all four trees: upstream revision, vendored package version, application package version, patch identity, and verification date. A lightweight check can catch manifest/version divergence and broken source paths. Prefer source symbols with a pinned revision over unexplained line ranges. Example: the React pattern's opening `package.json:1-4` citation does not even include the version field, which currently appears on line 8.

The catalog should provide decisions for APIs likely to be used or misused, rather than reproduce every upstream export. Prioritize redirect/tracing caveats and React drift first, then MCP/process and concrete HttpApi/Alchemy recipes.

## Verification and limits

Read all pattern pages and inspected selected cited source and application consumers. This worktree has no installed `node_modules`. For Effect, downloaded the exact 4.0.1 npm tarball into temporary storage and verified its SHA-512 integrity against `bun.lock` before inspecting source. Confirmed representative non-obvious behavior including D1 transaction limitations, queue completion/buffering, stream ordering options, and family-key hashing rather than assuming older Effect semantics.

React and dnd-kit checks used the vendored sources plus official React docs. Alchemy assessment used the documented source distinction, vendored beta.79 source, retained patch and current stack consumers; it is not a complete beta.80 provider audit. The HTTP redirect behavior was exercised in an isolated loopback probe. No claim is made that every export or sentence was runtime-tested. No application or pattern files were changed, and no application test suite was run for this documentation review.

## Implementation follow-up

The subsequent authorized update addressed the actionable recommendations above. The catalog now
includes MCP and child-process patterns, concrete HttpApi/observability/Alchemy recipes, React async
UI and optional API selection guidance, and dnd-kit observer/sortable guidance. It corrects redirect,
tracing, AI tool-resolution, React lifecycle and `Config.Redacted` guidance. Existing historical
checkouts remain explicitly distinguished from the selected application releases.

The [source manifest](../../.patterns/sources.json) records all four repositories, selected pins,
snapshot provenance and the retained Alchemy patch digest. The
[checker](../../scripts/check-pattern-sources.ts), wired into static verification, checks versions,
patches, source paths, local catalog links and index coverage. It does not validate API semantics or
line/heading anchors. dnd-kit's unavailable upstream commit is recorded honestly as a repository tree
identity rather than an invented upstream revision.

Follow-up source checks used integrity-verified published React 19.3.0 runtime/types and Alchemy
beta.80 source, including checking that the retained Alchemy patch applies. A metrics recipe also
ran against Effect 4.0.1. Targeted validation passed: seven checker/verification tests, TypeScript
checking for the new checker/tests, lint, formatting and the source checker itself. No application
runtime implementation changed, and the full application suite was not run.
