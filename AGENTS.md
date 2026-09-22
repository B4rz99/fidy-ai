# fidy-ai

fidy-ai has not been released, it is in development phase. Any backward compatibility or anything similar to that is completely unnecessary.

## Agent skills

### Issue tracker

Issues and PRDs live as **GitHub issues** in `B4rz99/fidy-ai`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

**Single-context**: one `CONTEXT.md` at the repo root, with ADRs in `docs/adr/`. See `docs/agents/domain.md`.

## Architecture and conventions

Before writing code, always read:

- **`CONTEXT.md`** — the ubiquitous language. Use these terms; avoid the listed synonyms.
- **`ARCHITECTURE.md`** — the system shape and cross-application boundaries.
- **`CODING_STANDARDS.md`** — how code is written inside that shape. Its two closing sections are
  the ones to check against: what is mechanically enforced, and what is review-only.
- **`SECURITY_STANDARDS.md`** — the mandatory security review invariants.

Then read the architecture document for every application the change touches:

- **`apps/server/ARCHITECTURE.md`** for server changes.
- **`apps/web/ARCHITECTURE.md`** for web changes.
- **Both application documents** for cross-application changes.

## Upstream references

Full checkouts of [Effect](https://effect.website) and [Alchemy](https://alchemy.run) live at `.repos/effect` and `.repos/alchemy`. Use the relevant checkout as the source of truth: read it to extract best practices, understand APIs and internals, check idiomatic usage, and verify behavior against the real implementation rather than guessing. Prefer it over memory when working with either dependency.

### Patterns

Distilled research on how Effect actually works, extracted from the `.repos/effect` source (citations are `path:line` into that checkout). Read the relevant file before working in its area; add a new file here when researching an Effect area not yet covered.

- `.patterns/effect-core.md` — Effect v4 core: `Effect.gen` vs Option/Result generators, `Effect.fn` tracing semantics, Promise interop, scoped resources, cancellation.
- `.patterns/http-client.md` — `effect/unstable/http`: policy-bearing clients, status/body handling, schema encoding/decoding, mutation-safe retries, rate limiting, redirects, tracing leakage, bounded responses.
- `.patterns/http-api.md` — `effect/unstable/httpapi`: define-once operation derivation (server / typed client / OpenAPI), request/response validation semantics, error modeling, schema patterns for operation definitions, testing seams, middleware, custom endpoint annotations + `HttpApi.reflect`, response headers, multipart, plain routes / raw bodies / static files.
- `.patterns/schema.md` — `effect` v4 Schema: one-schema-many-artifacts derivation (JSON codec / JSON Schema / equivalence), checks vs brands, `mapFields` derivation traps, tagged-union parsing, unstable `Model` variants/`optionalOption`, exact BigDecimal codec semantics for Money, `{ path, message }` issue formatting.
- `.patterns/sql.md` — `effect/unstable/sql` for a future Cloudflare D1 adapter: typed query seams, exact column mapping, atomic units, bounded responses, and structured failure classification. Do not reintroduce a process-local relational authority.
- `.patterns/workflows.md` — `unstable/workflow`: use for durable multi-step operations, Activities, durable sleeps/callbacks/queues, suspension, interruption, compensation, provider ambiguity, schema evolution, and User boundaries.
- `.patterns/crypto-encoding.md` — `Crypto`, `Encoding`, `Redacted`, and platform crypto: secure entropy/digests, strict binary decoding, secret lifetime, constant-time verification, token storage patterns, and deterministic tests.
- `.patterns/ai.md` — `effect/unstable/ai`: LanguageModel/Prompt/Tool/Toolkit mechanics, single-round tool resolution (no built-in agent loop), structured-output mapping, stub-model testing seams, and the hand-built HttpApi→Toolkit boundary. Hosted inference must enter through the Workers AI adapter.
- `.patterns/layers-runtime.md` — v4 services (`Context.Service`), Layer composition/memoization semantics, Config + ConfigProvider, Clock/TestClock seams, structured logging, Worker binding assembly, and graceful request/lifecycle shutdown.
- `.patterns/errors.md` — v4 typed error modeling: error classes (`Schema.TaggedErrorClass` vs `Data.TaggedError`), failures vs defects and the flat Cause model, catch/catchTag/catchReason semantics, `Result` at pure-core edges, the closed-error-set "reason pattern", schema-serializable errors for httpapi, Cause logging.
- `.patterns/concurrency-time.md` — v4 fibers/Ref/Queue/Schedule/Cron/Clock/TestClock and `unstable/persistence` RateLimiter: fork lifetimes, atomic process-local state, queue termination semantics, the per-user serialized-turn + debounce pattern, cron time zones, zone-aware DateTime math.
- `.patterns/streams.md` — v4 Stream and incremental encoding: bounded consumption, resource lifetime, cancellation, concurrency/backpressure, schema-aware NDJSON/Msgpack.
- `.patterns/observability.md` — v4 tracing/logging/metrics: Work-boundary spans, named `Effect.fn`, safe attributes and propagation, metrics cardinality, exporters, adapter tests.
- `.patterns/testing.md` — `@effect/vitest` v4 + `effect/testing`: it.effect/it.live/it.layer semantics, TestClock/TestConsole defaults, layer memoization and teardown fine print, Schema-driven property tests, Exit/Equal assertion idioms, HttpClient stub pattern, and Cloudflare binding seams. Do not recreate deleted runtime owners in tests.
- `.patterns/effect-atom.md` — Effect Atom + `@effect/atom-react`: state/registry ownership, authentication-lifetime isolation, Layer-backed runtimes, command semantics, complete AsyncResult rendering, AtomHttpApi failure behavior, query invalidation, hydration/persistence, React hooks, and tests.
- `.patterns/alchemy.md` — Alchemy v2 Cloudflare topology: Stack authority, static assets, public/private Workers, service bindings, domains, local parity, and safe release metadata. Read before changing Alchemy or Cloudflare topology.
- `.patterns/dnd-kit.md` — `@dnd-kit/react` 0.5: adapter boundaries, provider and hook lifecycles, pointer/touch/keyboard sensors, accessibility, nested collision priority, drop completion, overlays, and Dashboard integration rules. Read before dnd-kit or drag-and-drop work.

## React reference

The exact React 19.2.8 source lives at `.repos/react`. Read `.patterns/react.md` before writing React code; use it to locate runtime behavior and tests, while treating the installed public API and official React documentation as the application-facing contract.
