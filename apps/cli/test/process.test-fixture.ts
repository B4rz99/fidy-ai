// Test-only Bun process ownership, shared by native conformance and browser acceptance.
import { Data, Effect, Option, type Scope } from "effect";

export class ProcessUnavailable extends Data.TaggedError("ProcessUnavailable")<{}> {}
export type TestProcess = Readonly<{
  read: Effect.Effect<Option.Option<Uint8Array>, ProcessUnavailable>;
  exited: Effect.Effect<number, ProcessUnavailable>;
}>;
const unavailable = (): ProcessUnavailable => new ProcessUnavailable();
type ProcessReader = ReturnType<Bun.Subprocess<"ignore", "pipe", "ignore">["stdout"]["getReader"]>;
const releaseReader = (reader: ProcessReader): Effect.Effect<void, ProcessUnavailable> =>
  Effect.tryPromise({ try: () => reader.cancel(), catch: unavailable }).pipe(
    Effect.ensuring(Effect.sync(() => reader.releaseLock()))
  );
const awaitExit = (
  child: Bun.Subprocess<"ignore", "pipe", "ignore">
): Effect.Effect<number, ProcessUnavailable> =>
  Effect.tryPromise({ try: () => child.exited, catch: unavailable });

/** Every handle and reader settles inside its caller's Scope, including interruption. */
export const scopedProcess = Effect.fn(function* (
  command: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>
): Effect.fn.Return<TestProcess, ProcessUnavailable, Scope.Scope> {
  const resource = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const child = Bun.spawn([...command], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          ...(env === undefined ? {} : { env }),
        });
        const reader = child.stdout.getReader();
        return { child, reader };
      },
      catch: unavailable,
    }),
    ({ child, reader }) =>
      Effect.gen(function* () {
        child.kill();
        yield* awaitExit(child);
        yield* releaseReader(reader);
      }).pipe(Effect.orDie)
  );
  return {
    read: Effect.tryPromise({ try: () => resource.reader.read(), catch: unavailable }).pipe(
      Effect.map((chunk) => (chunk.done ? Option.none() : Option.some(chunk.value)))
    ),
    exited: awaitExit(resource.child),
  };
});
