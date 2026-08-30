# Effect dependency-replacement audit

Date: 2026-08-30
Audited revision: `a6fa58027a0a9695c6f486325f50ef6d9d273208` (`origin/trunk`)
Effect source: `.repos/effect` at `2600f62f4532026928454dcea8d1c48557b3f942` (Effect `4.0.0-rc.112`)

## Question

Can a direct dependency in Fidy be removed and have its responsibility supplied purely by Effect?

## Conclusion

**One direct dependency should be removed now: `@kapso/whatsapp-cloud-api`.** Fidy has no source import of that package. The production Kapso boundary is already a first-party `KapsoClientService` built with Effect services, typed failures, `Schema`, and a bounded HTTP adapter (`apps/server/src/shell/channels/whatsapp/kapso-client.ts:1-9,67-86,123-233,281-330`). The manifest nevertheless still declares the SDK (`apps/server/package.json:48-57`). Removing that declaration requires no behavioral replacement.

If “purely by Effect” also means eliminating the adapter's direct use of `globalThis.fetch`, this is feasible: Effect RC.112 provides a fetch-backed `HttpClient` whose fetch service defaults to `globalThis.fetch` (`.repos/effect/packages/effect/src/unstable/http/FetchHttpClient.ts:1-31,46-90`), and `HttpClientResponse` exposes response bytes as a `Stream` (`.repos/effect/packages/effect/src/unstable/http/HttpClientResponse.ts:280-314`). Migrating Kapso to that interface would make cancellation, transport substitution, and response streaming Effect-owned. It is an architectural consistency improvement, not a prerequisite for removing the already-unused SDK.

**No other currently used direct dependency has a complete, responsible Effect-only replacement in RC.112.** Replacing any of them would mean rebuilding a specialized parser, cryptographic protocol, provider protocol, native codec, UI primitive, or build tool—not merely adopting an Effect API.

## Runtime dependency assessment

### Server

| Dependency                  | Effect-only replacement? | Evidence and conclusion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@kapso/whatsapp-cloud-api` | **Yes / remove**         | No package import exists. Fidy already owns the Effect-based Kapso service and HTTP protocol boundary (`apps/server/src/shell/channels/whatsapp/kapso-client.ts:1-9,67-86,172-233,281-330`).                                                                                                                                                                                                                                                                                                                  |
| `@sentry/bun`               | No                       | The adapter constructs and validates Sentry envelopes, scopes, events, and transports (`apps/server/src/shell/observability/sentry-adapter.ts:1-39,48-92,106-209`). Effect supplies tracing primitives, but RC.112 contains no Sentry transport or envelope implementation.                                                                                                                                                                                                                                   |
| `csv-parse`                 | No                       | Fidy relies on quoted-record parsing, delimiter selection, raw-record evidence, physical-line tracking, BOM handling, relaxed column counts, and record-size bounds (`apps/server/src/shell/ingestion/parser.ts:1-5,48-124`). Effect has schema decoding and delimited-string helpers, not a CSV grammar implementing this contract.                                                                                                                                                                          |
| `jose`                      | No                       | The recovery boundary needs remote JWKS retrieval, RS256 verification, issuer/audience checks, and JWT claim verification (`apps/server/src/shell/recovery/access.ts:1-2,22-64,82-94`). Effect's `Crypto` service provides random values and message digests, not JWT/JWS/JWKS verification (`.repos/effect/packages/effect/src/Crypto.ts:1-14,28-113`).                                                                                                                                                      |
| `js-tiktoken`               | No                       | Fidy needs the exact OpenAI `o200k_base` tokenization algorithm (`apps/server/src/shell/agent/openai.ts:1-17`). Effect's `Tokenizer.make` requires the application to supply the tokenization function (`.repos/effect/packages/effect/src/unstable/ai/Tokenizer.ts:1-10,114-154`), while the OpenAI package's tokenizer model remains commented TODO code (`.repos/effect/packages/ai/openai/src/OpenAiLanguageModel.ts:580-595`). Effect can host the service, but cannot replace the algorithm dependency. |
| `sharp`                     | No                       | Fidy uses native image metadata decoding with pixel/page constraints (`apps/server/src/shell/ingestion/resend-receiving-client.ts:15,150-174`). Effect provides orchestration, not image codecs.                                                                                                                                                                                                                                                                                                              |
| `svix`                      | No                       | The public boundary verifies the provider's exact signed bytes using Svix's timestamped multi-signature protocol (`apps/server/src/shell/ingestion/forwarded-email-ingestion.ts:1-12,32-70,82-107`). RC.112 has no Svix verifier; replacing it would be security-sensitive protocol reimplementation.                                                                                                                                                                                                         |
| `xlsx`                      | No                       | Fidy reads XLSX workbook, worksheet, range, and cell representations (`apps/server/src/shell/ingestion/parser.ts:1-5` and the remainder of that parser). Effect does not implement OOXML/ZIP workbook semantics.                                                                                                                                                                                                                                                                                              |

The existing Effect-family dependencies (`@effect/ai-openai`, `@effect/platform-bun`, `@effect/sql-pg`, and `effect`) are already the intended implementations, not replacement candidates (`apps/server/package.json:45-58`).

### Web

None of the web runtime dependencies is replaceable by Effect alone. Effect Atom owns server/shared state, but RC.112 does not supply React, routing, accessible UI primitives, drag-and-drop, charting, icons/fonts, or Tailwind class semantics. The application actively uses those libraries at their intended boundaries—for example TanStack Router throughout `apps/web/src/app/routes.ts:1-138`, Base UI in `apps/web/src/ui/components/button.tsx:1-2` and sibling components, and Recharts in `apps/web/src/features/dashboard/view.tsx:1-17`.

`clsx`, `tailwind-merge`, and `class-variance-authority` could potentially be consolidated with other CSS-specific code, but that would not be an Effect replacement. The current `cn` helper explicitly combines conditional class composition with Tailwind conflict resolution (`apps/web/src/ui/class-names.ts:1-5`).

`scheduler` is not imported directly by Fidy, but it is a peer dependency of `@effect/atom-react` and a dependency of `react-dom` in the lockfile (`bun.lock:221-225,1389-1393`). It should not be classified as an unused Effect-replacement candidate without first proving a frozen install and browser build after manifest removal.

## Tooling dependencies

Effect does not replace the repository's compiler, AST tooling, formatter/linter, hooks, test runner, browser runner, coverage implementation, OpenAPI compatibility engine, deployment CLI, or source-map uploader. In particular:

- Babel parses and traverses TypeScript/TSX for repository guards (`scripts/check-credential-evidence.ts:1-5`, `scripts/check-web-design-system.ts:1-5`).
- Istanbul merges coverage maps (`scripts/ci/merge-server-coverage.ts:1-3`).
- `@oasdiff-js/oasdiff-js` performs semantic breaking-change analysis (`apps/server/tools/contracts/compatibility.ts:1`). Effect generates OpenAPI, but does not compare two OpenAPI contracts.

## Recommended next change

Open one narrow cleanup ticket:

1. Delete `@kapso/whatsapp-cloud-api` from `apps/server/package.json` and regenerate `bun.lock`.
2. Prove frozen installation, dependency guards, server tests, production build, and production image.
3. Separately decide whether to migrate `KapsoClientService` from its bounded native-fetch seam to Effect `HttpClient`. Do not combine that behavioral transport refactor with the dependency-only cleanup unless its tests are written first.

## Method

The audit enumerated every direct root, server, and web dependency at the audited revision, searched application/tool source for exact package references, and checked plausible replacements against the checked-in RC.112 Effect implementation. “Replaceable” means Effect supplies the specialized behavior, not merely that Effect can wrap custom code implementing it.
