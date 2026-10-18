# Typed errors (v4)

Sources: `node_modules/effect/src/{Data,Schema,Cause,Exit,Effect,Result}.ts`. For library reason
patterns inspect `sql/SqlError.ts` and `ai/AiError.ts` under the same source directory.
HTTP projection is a separate boundary; see [HttpApi](http-api.md).

## Define a closed failure vocabulary

Use `Data.TaggedError("Tag")<Fields>` for internal failures and
`Schema.TaggedErrorClass<Self>()("Tag", fields)` when the error crosses a Schema boundary.
Both create yieldable error instances; `yield* new Failure(...)` fails an Effect.
Fields named `message` and `cause` participate in native Error behavior. Keep tags distinct within
a handled union: `catchTag` matches the string, not the class identity.

Schema-serializable does not mean safe to publish. `Schema.Defect()` can encode arbitrary error
information; it is not a redactor. Public failures contain the owner's approved fields, not broad
causes, statements, bodies, or rejected secret input.

For pure synchronous decisions, use Option for absence and Result for a typed failure where those
fit the owner's contract. Effect is also valid for service-free domain decisions. Do not change an
existing owner to Result merely to imitate a library example. Lift Option/Result into Effect using
`fromOption` / `fromResult`; their generator protocols are not interchangeable with `Effect.gen`.

## Failures, defects, interruption

`Effect.fail` raises a typed failure; `Effect.die` raises a defect; a throw inside a generator is a
defect. `Effect.try` / `tryPromise` map foreign failures via `catch`; without it they introduce
`Cause.UnknownError`. Use `orDie` only when the typed failure genuinely means a broken invariant at
that boundary.

`Cause<E>` contains a flat array of Fail, Die, and Interrupt reasons. `Exit` is Success or Failure
holding the whole Cause. Keep interruption distinct from domain refusal and provider failure.

- `catchTag` / `catchTags` handle typed failures; `catchTag` can accept an array of tags.
- `mapError` maps typed failures, not defects.
- `catchReason` / `catchReasons` handle a tagged reason inside a parent error; `unwrapReason`
  replaces the wrapper with its reason union.
- `catchCause` observes the complete failure structure; `catchDefect` handles defects deliberately
  at an integration boundary. They are not ordinary typed-error handlers.

A cause can hold multiple Fail reasons. Ordinary typed catches select a matching error rather than
preserving an accumulated error report. Inspect the complete Cause when accumulation matters.

Use `mapError` for direct error translation. Keep internal composition in Effect: a
`runPromise`/`tryPromise` round trip can turn a defect into a retryable foreign failure. Recovery
must handle an actual typed failure; an infallible operation needs no typed catch. Verify the
selected operation's error type before removing recovery, and retain intentional Cause containment.

For a lazy successful fallback use `orElseSucceed`. An Option-valued operation falling back to
absence uses `Effect.orElseSucceed(Option.none)`; `Effect.option` instead wraps successful values
in another Option. See `mapError` and `orElseSucceed` in `src/internal/effect.ts` and the narrow
[recovery lint rule](../scripts/oxlint/effect-recovery.js). Its binding-aware fixtures constrain
the automated rule to trivial callbacks; it is not a blanket ban on recovery.

## Accumulation, retry, and timeout

Ordinary composition fails fast. `Effect.all(..., { mode: "result" })` collects per-item Results;
`Effect.validate` can accumulate multiple Fail reasons; `Effect.partition` separates failures and
successes. Bound concurrency even when collecting errors.

Retry requires the owner's certainty and idempotency rules, not just a library `isRetryable` flag.
`timeout` adds `Cause.TimeoutError`, while `timeoutOption` models timeout as absence. Neither proves
that a remote mutation did not commit.

## HTTP and telemetry

Endpoint error schemas determine which failures can be encoded. `HttpApiSchema.status(code)` adds
status metadata; it does not authorize an operation or sanitize its fields. Map adapter failures to
the declared public union before the HTTP seam. Unexpected failures remain defects with safe public
projection rather than leaking internal Error objects.

`Cause.pretty`, `prettyErrors`, and `squash` are inspection tools, not public error codecs.
`Effect.logError("failed", cause)` can render nested causes and their messages. Fidy telemetry uses
allowlisted categories instead; even a typed error may retain private data. `ErrorReporter.ignore`
controls reporting, not classification, authorization, or redaction.
