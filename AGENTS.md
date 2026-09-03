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

## Effect reference

A full checkout of the [Effect](https://effect.website) source lives at `.repos/effect`. This project is built on Effect, so use that checkout as the source of truth: read it to extract best practices, understand how APIs and internals actually work, check idiomatic usage, and verify behavior against the real implementation rather than guessing. Prefer it over memory when working with Effect.

### Patterns

Distilled research on how Effect actually works, extracted from the `.repos/effect` source (citations are `path:line` into that checkout). Read the relevant file before working in its area; add a new file here when researching an Effect area not yet covered.

- `.patterns/effect-core.md` — Effect v4 core: `Effect.gen` vs Option/Result generators, `Effect.fn` tracing semantics, Promise interop, scoped resources, cancellation.
- `.patterns/http-client.md` — `effect/unstable/http`: policy-bearing clients, status/body handling, schema encoding/decoding, mutation-safe retries, rate limiting, redirects, tracing leakage, bounded responses.
- `.patterns/http-api.md` — `effect/unstable/httpapi`: define-once operation derivation (server / typed client / OpenAPI), request/response validation semantics, error modeling, schema patterns for operation definitions, testing seams, middleware, custom endpoint annotations + `HttpApi.reflect`, response headers, multipart, plain routes / raw bodies / static files.
- `.patterns/schema.md` — `effect` v4 Schema: one-schema-many-artifacts derivation (JSON codec / JSON Schema / equivalence), checks vs brands, `mapFields` derivation traps, tagged-union parsing, exact BigDecimal codec semantics for Money, `{ path, message }` issue formatting.
- `.patterns/sql.md` — `effect/unstable/sql` + `@effect/sql-pg`: PgClient layers, the `sql` tag and record helpers, SqlSchema typed query seams, column-mapping idioms (numeric→BigDecimal, timestamptz→DateTime, jsonb), transaction/savepoint semantics, structured SqlError classification, the Migrator.
- `.patterns/persisted-queue.md` — `unstable/persistence/PersistedQueue`: use before replacing claim tables, leases, polling loops, or durable retry workers; SQL transaction coupling, deduplication, attempts, lock recovery, shutdown, payload evolution, retention, and PostgreSQL tests.
- `.patterns/workflows.md` — `unstable/workflow`: use for durable multi-step operations, Activities, durable sleeps/callbacks/queues, suspension, interruption, compensation, provider ambiguity, schema evolution, and User boundaries.
- `.patterns/cluster.md` — `unstable/cluster` + `ClusterWorkflowEngine`: use for production workflow composition, entities/sharding, SQL message and runner storage, multi-runner/client-only topology, lifecycle, retention, transport security, and failover tests.
- `.patterns/ai.md` — `effect/unstable/ai` + `@effect/ai-openai`: LanguageModel/Prompt/Tool/Toolkit mechanics, single-round tool resolution (no built-in agent loop), structured-output wire mapping to OpenAI `json_schema`, McpServer stdio derivation from toolkits, stub-model testing seams, the hand-built HttpApi→Toolkit boundary.
- `.patterns/layers-runtime.md` — v4 services (`Context.Service`), Layer composition/memoization semantics, Config + ConfigProvider, Clock/TestClock seam, structured logging, single-process runtime assembly on Bun (`Layer.launch` + `BunRuntime.runMain`, graceful shutdown).
- `.patterns/errors.md` — v4 typed error modeling: error classes (`Schema.TaggedErrorClass` vs `Data.TaggedError`), failures vs defects and the flat Cause model, catch/catchTag/catchReason semantics, `Result` at pure-core edges, the closed-error-set "reason pattern", schema-serializable errors for httpapi, Cause logging.
- `.patterns/concurrency-time.md` — v4 fibers/Queue/Schedule/Cron/Clock/TestClock and `unstable/persistence` RateLimiter: fork lifetimes, queue termination semantics, the per-user serialized-turn + debounce pattern, cron time zones, zone-aware DateTime math.
- `.patterns/streams.md` — v4 Stream and incremental encoding: bounded consumption, resource lifetime, cancellation, concurrency/backpressure, schema-aware NDJSON/Msgpack.
- `.patterns/observability.md` — v4 tracing/logging/metrics: Work-boundary spans, named `Effect.fn`, safe attributes and propagation, metrics cardinality, exporters, adapter tests.
- `.patterns/testing.md` — `@effect/vitest` v4 + `effect/testing`: it.effect/it.live/it.layer semantics, TestClock/TestConsole defaults, layer memoization and teardown fine print, Schema-driven property tests, Exit/Equal assertion idioms, HttpClient stub pattern, testcontainers Postgres practice, Bun caveats.
- `.patterns/effect-atom.md` — Effect Atom + `@effect/atom-react`: Layer-backed runtimes, scoped resource ownership, AsyncResult, derived and family atoms, typed HttpApi queries/mutations, invalidation, cache lifetime, React hooks, and testing seams.
- `.patterns/dnd-kit.md` — `@dnd-kit/react` 0.5: adapter boundaries, provider and hook lifecycles, pointer/touch/keyboard sensors, accessibility, nested collision priority, drop completion, overlays, and Dashboard integration rules. Read before dnd-kit or drag-and-drop work.
- `.patterns/effect-v4-audit.md` — RC.112 coverage audit, source conflicts, concrete application review candidates, and intentionally rejected cargo-cult adoptions.

## React reference

The exact React 19.2.8 source lives at `.repos/react`. Read `.patterns/react.md` before writing React code; use it to locate runtime behavior and tests, while treating the installed public API and official React documentation as the application-facing contract.
