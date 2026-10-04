# Effect core, interop & resources (v4)

Source: the selected release's `node_modules/effect/src/Effect.ts` and
`node_modules/effect/src/internal/effect.ts`. Search the named symbols below; see
[the source map](effect-4-stable.md) for the distinction between installed and upstream source.

## Generators and reusable functions

`Effect.gen` accepts Effect yields. `Option` and `Result` have their own generator protocols;
lift them with `Effect.fromOption` / `Effect.fromResult` when crossing into Effect. Context services,
Config, and yieldable error instances support Effect composition through their own contracts.
The upstream `migration/yieldable.md` examples claiming direct Option/Result yields disagree with
the selected implementation: use `Effect.gen`'s signature and the runtime, not that migration text.

- Named `Effect.fn("operation")(body)` adds a tracing span each time the returned Effect runs.
  Use it for meaningful Work, not each row or field.
- Unnamed `Effect.fn(body)` retains stack instrumentation without a named span.
- `Effect.fnUntraced(body)` omits that instrumentation for private plumbing.
- `Effect.gen({ self }, body)` and `Effect.fn({ self }, body)` bind an explicit receiver.

## Foreign calls

Use `Effect.tryPromise({ try, catch })` for fallible foreign promises and `Effect.try({ try, catch })`
for fallible synchronous calls. Map to the owning closed error set. Omitting `catch` introduces
`Cause.UnknownError`; throwing inside `catch` creates a defect.

`Effect.promise` and `Effect.sync` are for operations whose failure is a defect, not an expected
business outcome. Pass the supplied `AbortSignal` into cancellable foreign APIs. Fiber interruption
stops waiting but cannot stop an external operation that ignores cancellation.

Run `Effect.runPromise` / `runFork` only at a genuine non-Effect entrypoint. Within an Effect,
compose the work instead of starting another runtime.

## Resource ownership

| Lifetime                               | Primitive                    |
| -------------------------------------- | ---------------------------- |
| Surrounding scope owns the resource    | `Effect.acquireRelease`      |
| One acquire/use/release operation      | `Effect.acquireUseRelease`   |
| JS `Disposable` / `AsyncDisposable`    | `Effect.acquireDisposable`   |
| Close resources when an operation ends | `Effect.scoped`              |
| Attach cleanup to an effect            | `Effect.ensuring` / `onExit` |
| Register low-level scope cleanup       | `Effect.addFinalizer`        |

`acquireRelease` acquisition is uninterruptible by default; release is registered only after
successful acquisition and receives the closing Exit. `Layer.effect` already supplies a construction
scope. Adding an inner `Effect.scoped` closes resources before the layer's service escapes.

Every adapter must establish who owns cleanup and what interruption does to external work. Preserve
interruption rather than turning it into a validation/domain failure. A provider timeout does not
prove the provider rejected the request; reconciliation belongs to the owning operation.
