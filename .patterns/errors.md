# Typed errors

How Effect v4 models, raises, catches, serializes, and logs typed errors, read from the
source. Citations are `<path>:<line>` relative to `packages/effect/`; `ai-docs ...` paths are
relative to the repo root. Canonical walkthrough: `ai-docs/src/01_effect/04_errors/`. HTTP-layer
error semantics (statuses, empty 400s, client decode-by-status) live in `.patterns/http-api.md`;
this file covers the domain/Effect side up to that boundary.

## Defining error types

| Primitive                                        | Use for                                                                                                                                                                                                 | What you get                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Schema.TaggedErrorClass<Self>()("Tag", fields)` | anything that may cross a schema boundary (httpapi `error:`, RPC, persisted) — the ai-docs house default even for service-internal errors (`ai-docs/src/01_effect/04_errors/01_error-handling.ts:9-16`) | schema-validated constructor + `_tag` auto-populated (`Schema.ts:12981-13015`), `YieldableError`, decodes back into real class instances |
| `Data.TaggedError("Tag")<Fields>`                | internal-only errors; the repo core's own choice (`SchemaError.ts:41`, `Cron.ts:487`)                                                                                                                   | plain class, no schema; structural `Equal` by fields+tag (`test/Data.test.ts:60-67`)                                                     |
| plain class with `readonly _tag`                 | works with `catchTag` (doc example `Effect.ts:2678-2694`) but is **not yieldable** and has no `Equal`                                                                                                   | avoid                                                                                                                                    |

Both real variants extend `globalThis.Error` via `YieldableError`: yielding an instance in
`Effect.gen` fails the effect with it (`internal/core.ts:565-582` — evaluate → `exitFail(this)`;
test `test/Data.test.ts:202-210`). Constructor args named `message`/`cause` are forwarded to the
native `Error` constructor, so cause chaining is free (`internal/core.ts:585-605`); `name` is set
to the tag (`internal/core.ts:616`); a stack trace is captured at construction
(`test/Data.test.ts:190-194`, `test/schema/Schema.test.ts:6788`). `toJSON` includes all fields
(`internal/core.ts:601-603`).

`Schema.TaggedErrorClass` = `ErrorClass` + `_tag: Schema.tag(tag)` prepended to the fields
(`Schema.ts:13005-13009`); `Schema.tag` is a literal with a constructor default
(`Schema.ts:5974-5977`), so `new NotFound({ id })` omits `_tag`. The schema constructor validates
and **drops excess properties** by default (`test/schema/Schema.test.ts:6796-6810`); `String(err)`
prints only the identifier (`test/schema/Schema.test.ts:6787`). `extend` works on error classes
(`test/schema/Schema.test.ts:6848-6869`). For a `cause` field holding arbitrary values use
`Schema.Defect()` — encodes any value to JSON, decodes error-shaped JSON back to `Error`, omits
stacks by default (`Schema.ts:9530-9539`, gotchas at `Schema.ts:9512-9524`).

## Failures vs defects

`Effect.fail(e)` → typed failure; `Effect.die(u)` → defect; `Effect.failCause(cause)` for a
prebuilt cause (`Effect.ts:1478`, `:1612`, `:1539`). A `Cause<E>` is now a **flat array**:
`{ reasons: ReadonlyArray<Fail<E> | Die | Interrupt> }` — the v3 Sequential/Parallel tree is gone
(`Cause.ts:77-80`, `:146`). Each reason carries an annotations map (`Cause.ts:129-130`).
`Exit<A, E> = Success | Failure`, where `Failure` holds the full `cause` (`Exit.ts:59`, `:158`).

- A `throw` anywhere inside an `Effect.gen` body or `Effect.sync` becomes a **defect**
  (`internal/effect.ts:1297-1299`; `catchDefect` example `Effect.ts:3234-3243`).
- `Effect.orDie` moves the whole typed error channel to defects (`Effect.ts:3622`) — the idiom for
  "this error is a bug here". `Effect.catchDefect` / `Effect.catchCause` recover at integration
  boundaries only (`Effect.ts:3249`, `:3200`).
- Inspect causes with `Cause.hasFails/hasDies/hasInterrupts`, `findError`, `findDefect`
  (`Cause.ts:781-973`).

## Selective handling

All `catch*` variants operate on **Fail reasons only**; defects and interrupts pass through
(`Effect.ts:2646-2650`). `Effect.catch` is implemented as `catchCauseFilter(self, findError, f)` —
the handler receives the first typed error in the cause (`internal/effect.ts:2498-2512`).

- `catchTag(tag | [tags], f, orElse?)` — v4 accepts an **array of tags** in one call, and an
  optional `orElse` for the remaining union members (`Effect.ts:2703-2753`; tests
  `test/Effect.test.ts:1921-1949`).
- `catchTags({ Tag: f, ... }, orElse?)` — handler table (`Effect.ts:2799-2861`).
- `catchIf(refinement, f, orElse?)` / `catchFilter(Filter.tagged("Tag"), f)`
  (`Effect.ts:3301-3328`, `:3354`; `Filter.ts:471`).
- `mapError(f)` transforms the typed error, defects untouched (`Effect.ts:3533`); `tapError`,
  `tapCause` for observation (`Effect.ts:3656`, `:3758`); `Effect.flip` swaps channels
  (`Effect.ts:2463`).
- **Reason pattern** combinators, for errors with a tagged `reason` field:
  `catchReason("Parent", "ReasonTag", f, orElse?)` (`Effect.ts:2908-2964`),
  `catchReasons("Parent", { ReasonTag: f }, orElse?)` (`Effect.ts:3001-3085`), and
  `unwrapReason("Parent")` which replaces the parent in the error channel with its reason union
  (`Effect.ts:3142-3158`). Unmatched reasons re-fail with the original parent error (tests
  `test/Effect.test.ts:2727-2745`, `:2799-2809`; walkthrough
  `ai-docs/src/01_effect/04_errors/20_reason-errors.ts`).

## Pure-core fallible functions (repo house style)

- Single obvious failure mode → `Option`: `BigDecimal.divide` returns `Option<BigDecimal>`,
  paired with a throwing `divideUnsafe` (`BigDecimal.ts:589-605`, `:644`).
- Typed error payload → `Result`: v4 renamed `Either` to `Result<A, E>` with `succeed`/`fail`
  (`Result.ts:70`, `:284`, `:314`). Exemplar: `Cron.parse` returns
  `Result<Cron, CronParseError>` where `CronParseError extends Data.TaggedError`
  (`Cron.ts:572`, `:487`).
- For Money: `add/compare` returning `Result<_, CurrencyMismatch>` matches the Cron pattern —
  pure, sync, typed, no Effect in the core.
- **Result and Option are not Effects in v4.** `Effect.gen` only accepts Effect yields at the type
  level (`Effect.ts:1405-1416`). Lift at the edge with `Effect.fromResult` (`Effect.ts:1781`) or
  `Effect.fromOption(opt, onNone?)` — bare form fails with `Cause.NoSuchElementError`
  (`Effect.ts:1818`). Pure do-notation exists as `Result.gen` / `Option.gen` (`Result.ts:1560`,
  `Option.ts:2525`).

## Error unions across service seams

Service methods declare their own `E`; unions accumulate structurally through `Effect.gen`. The
seam idiom is a per-service wrapper holding the low-level cause:
`class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", { cause: Schema.Defect() })`
(`ai-docs/src/01_effect/03_services/01_service.ts:39-41`). Map foreign errors into it with
`Effect.tryPromise({ try, catch: (cause) => new DatabaseError({ cause }) })`
(`Effect.ts:920-937`).

- `Effect.retry(policy)` preserves the typed error: `Effect<A, E | ScheduleError, R>`
  (`Effect.ts:4040-4061`); `retryOrElse` adds a fallback receiving the last error
  (`Effect.ts:4119`). Retryability as a **getter on the error** is the house pattern —
  `SqlError.isRetryable` / `AiError.isRetryable` delegate to the reason
  (`unstable/sql/SqlError.ts:418-420`, `unstable/ai/AiError.ts:1477-1479`).
- `Effect.timeout(d)` adds `Cause.TimeoutError` to the union (`Effect.ts:4494-4502`;
  `Cause.ts:1453-1473`); `timeoutOption` models it as `Option.none` instead (`Effect.ts:4553`).

## Accumulating vs failing fast

Default is fail-fast; started concurrent effects are interrupted (`Effect.ts:390-395`).

- `Effect.all(effects, { mode: "result" })` runs everything, collecting per-slot `Result`s
  (`Effect.ts:373`, `:521`).
- `Effect.validate(items, f)` runs every element and fails with **multiple Fail reasons in one
  Cause** (`Effect.ts:568-606` — the example output shows two `Fail` entries in `reasons`).
- `Effect.partition(items, f)` never fails: `[failures, successes]` (`Effect.ts:556-566`).

## Schema-serializable errors and closed error sets

An error class **is** its schema — it can be passed directly as an httpapi `error:` declaration;
the client decodes the response body back into a real class instance, so `catchTag` works across
the wire (see http-api.md "Client semantics"). Status is an annotation:
`HttpApiSchema.status(code)` is sugar for `.annotate({ httpApiStatus: code })`
(`unstable/httpapi/HttpApiSchema.ts:153`, `:168`), and the built-in `HttpApiError` classes pass
`httpApiStatus` straight in the annotations argument
(`unstable/httpapi/HttpApiError.ts:42-53`).

The repo models closed error sets two ways:

1. **Flat set** — one `Schema.ErrorClass` per member with `_tag: Schema.tag(...)`, singletons for
   empty ones (`HttpApiError.ts:42-53`). Fine when members share no structure.
2. **Reason pattern** (the house pattern for domain sets — `SqlError`, `AiError`): one
   `TaggedErrorClass` per code sharing a fields record (`unstable/sql/SqlError.ts:19-23`, `:31`),
   an explicit `Schema.Union([...])` of all of them exported alongside the union type
   (`SqlError.ts:335-378`, `AiError.ts:1380-1418`), and a single wrapper error with
   `reason: TheUnion` that overrides `cause = this.reason` and derives `message`/`isRetryable`
   from the reason (`SqlError.ts:387-421`, `AiError.ts:1461-1493`). Consumers handle one `SqlError`
   tag or drill in with `catchReason`/`unwrapReason`. For fidy's API error codes this is the shape:
   per-code `TaggedErrorClass` (tag = the code), a union schema, `httpApiStatus` annotated per
   member, wrapper only if a single error type should ride the seam. If the wire discriminator
   is a `code` field rather than `_tag`, `Schema.tagDefaultOmit` drops `_tag` from encoded output
   (`Schema.ts:6010`).

## Logging causes

`Cause.pretty(cause)` renders the whole cause — every reason, nested `Error.cause` chains
indented, span annotations appended to stack frames (`Cause.ts:1159`, rendering details
`:1116-1140`); `Cause.prettyErrors` returns the `Error` instances (`Cause.ts:1111`);
`Cause.squash` lossily collapses to one value (`Cause.ts:756`). You rarely call these:
`Effect.log*` scans its arguments for `Cause` values and merges them into the log entry's cause
slot (`internal/effect.ts:6144-6158`), which the default loggers render via pretty
(`Logger.ts:416`, structured `:656`). So `Effect.logError("failed", cause)` is full-fidelity.
`ErrorReporter` (v4-new) forwards causes to monitoring; `[ErrorReporter.ignore] = true` on an
error class opts it out, as `HttpApiError` does (`ErrorReporter.ts:1-12`,
`HttpApiError.ts:49`).

## Traps

- **`Effect.try`/`tryPromise` without `catch` fail typed, not dead**: the default `E` is
  `Cause.UnknownError` in the error channel (`Effect.ts:943`, `:1614`) — it silently widens your
  union instead of becoming a defect. Always pass `catch:` mapping to a domain error. If `catch`
  itself throws, _that_ is a defect (`Effect.ts:898-902`).
- **`throw` inside `Effect.gen` is a defect** (`internal/effect.ts:1297-1299`) — a validation
  `throw` in domain code skips every `catchTag` and surfaces as a 500. Fail with a typed error or
  let it die deliberately.
- **You cannot `yield*` a `Result`/`Option` inside `Effect.gen`** — they are not Effects in v4
  (`Effect.ts:1405-1416`); only error-class _instances_ are yieldable. Lift with
  `Effect.fromResult`/`fromOption`.
- **Two errors, one tag**: `catchTag` matches only the `_tag` string. Two classes accidentally
  sharing a tag are indistinguishable to it, and `Equal` on `Data` errors is structural by
  fields+tag (`test/Data.test.ts:60-67`) — keep tags globally unique; namespaced schema
  identifiers (`"effect/sql/SqlError/ConnectionError"`) are only the _schema_ identity, not the tag.
- **A cause can hold several Fail reasons** (`Effect.validate`, concurrent failures) but
  `Effect.catch`/`catchTag` hand your handler only the first one found
  (`internal/effect.ts:2510-2512`); recover with `catchCause` when accumulation matters.
- **`message` is special**: an error field named `message`/`cause` feeds the native `Error`
  constructor (`internal/core.ts:591`). A schema error class without a `message` field logs with
  an empty message — override `get message()` derived from the fields, as `SqlError`/`AiError` do
  (`SqlError.ts:409-411`, `AiError.ts:1490-1492`).
- **Declared-vs-undeclared at the HTTP seam**: only errors in the operation's `error:` schema
  encode to responses; anything else is `orDie`'d to an empty 500 (http-api.md "Server pipeline
  semantics" #4-6). Keep the endpoint's `E` equal to its declared union and `orDie` the rest
  explicitly in the handler.
