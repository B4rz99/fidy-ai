# Effect core, interop & resources (v4)

How the stable Effect v4 core should be used in this repository. Citations are relative to
`.repos/effect/packages/effect/`; migration notes are secondary to the checked-out RC.112
implementation and tests.

## `Effect.gen` accepts Effects, not every generator-friendly value

`Effect.Effect` has its own iterator protocol (`Effect.ts:117-120`, `:245-249`). `Option` and
`Result` also have iterator protocols, but those are documented for `Option.gen` and `Result.gen`,
not for `Effect.gen` (`Option.ts:75-105`; `Result.ts:95-128`). In this checkout, yielding an
`Option` or `Result` from `Effect.gen` is both rejected by the intended type contract and fails at
runtime as “Not a valid effect”.

Therefore:

- compose pure optional/fallible work with `Option.gen` / `Result.gen`;
- cross into Effect with `Effect.fromOption` / `Effect.fromResult`;
- yielding a `Data.TaggedError` or `Schema.TaggedErrorClass` instance is valid because those error
  classes are Effect-yieldable failures (see `errors.md`);
- yielding a `Context.Service`, `Config`, or ordinary `Effect` follows that value's actual Effect
  contract; do not infer Effect compatibility merely from the presence of `Symbol.iterator`.

The migration note `migration/yieldable.md` currently overstates cross-generator yieldability for
`Option` and `Result`; the installed source and runtime win.

## Reusable Effect functions

`Effect.fn` reuses the generator body and provides a stack-frame boundary. The **named** form,
`Effect.fn("name")(body)`, additionally creates a tracing span whenever the returned Effect runs;
the unnamed form does not. `Effect.fnUntraced` omits tracing/stack instrumentation
(`Effect.ts:13481`, `:13605` and the detailed contract at `:13484-13608`).

Repository rule:

- use named `Effect.fn` for bounded Work that deserves a span;
- use unnamed `Effect.fn` or `Effect.fnUntraced` for small decoders, row mappers, and private
  plumbing that should not create one telemetry span per call;
- never assume `Effect.fn("name")` is only a nicer function name.

For methods requiring `this`, v4 takes `{ self }` before the body rather than v3's positional self
(`migration/generators.md:1-32`).

## Promise and callback interop

- `Effect.promise` is only for a Promise guaranteed not to reject. A rejection becomes a **defect**;
  interruption only cancels underlying work if the Promise API observes the supplied
  `AbortSignal` (`Effect.ts:858-900`).
- `Effect.tryPromise({ try, catch })` is the normal foreign-Promise seam. It maps synchronous throws
  and asynchronous rejection into the typed error channel. The thunk-only overload introduces
  `Cause.UnknownError`; a throwing `catch` callback defects (`Effect.ts:902-975`).
- Pass the provided signal to `fetch` or another cancellable API. Wrapping an API while discarding
  the signal makes fiber interruption stop waiting but may leave the external work running.
- `Effect.sync` is for synchronous work that cannot throw. Use `Effect.try({ try, catch })` when a
  synchronous foreign call can throw; the same closed-error-set rule applies.
- `Effect.runPromise` / `runFork` belong only at a genuine non-Effect entrypoint. Inside Effect code,
  compose the Effect instead of starting a second runtime boundary.

## Resource ownership

Choose the highest-level primitive that expresses the lifetime:

| Need                                      | Primitive                    | Contract                                                                                                                                              |
| ----------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resource lives for a surrounding scope    | `Effect.acquireRelease`      | acquisition is uninterruptible by default; release receives the scope's `Exit` and is guaranteed after successful acquisition (`Effect.ts:6517-6584`) |
| One acquire/use/release workflow          | `Effect.acquireUseRelease`   | brackets use directly; release is uninterruptible and its failure joins the error channel (`Effect.ts:6652-6718`)                                     |
| JS `Disposable` / `AsyncDisposable`       | `Effect.acquireDisposable`   | v4-native scoped bridge using `Symbol.dispose` / `Symbol.asyncDispose` (`Effect.ts:6586-6649`)                                                        |
| Close all resources at workflow end       | `Effect.scoped`              | closes on success, failure, or interruption (`Effect.ts:6414-6470`)                                                                                   |
| Attach non-resource cleanup to one effect | `Effect.ensuring` / `onExit` | low-level finalization; prefer acquire/release for resources (`Effect.ts:6796-6820`)                                                                  |
| Register low-level scope cleanup          | `Effect.addFinalizer`        | finalizer receives the closing `Exit` (`Effect.ts:6719-6768`)                                                                                         |

`Layer.effect` already supplies a construction scope, so resource acquisition inside a Layer does
not need an inner `Effect.scoped` (`layers-runtime.md`). A locally-created `Effect.scoped` closes
before its result escapes; do not return a handle whose lifetime belonged to that now-closed scope.

## Cancellation is part of the API

Interruption reaches Effect sleeps, queues, HTTP requests, scoped fibers, and correctly wrapped
foreign APIs. It does not magically cancel a Promise, subprocess, or SDK call that ignores its
signal or lacks a finalizer. At every adapter answer both questions:

1. What happens to the external operation when the fiber is interrupted?
2. Which scope owns cleanup if the operation acquired a resource?

Do not turn interruption into an ordinary domain failure merely to simplify a union. Preserve it
unless the boundary deliberately converts cancellation into a protocol outcome.
