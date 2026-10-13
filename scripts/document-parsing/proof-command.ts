import { type Cause, Data, Effect, Option, Stream } from "effect";

const outputLimit = 1_048_576;
const shutdownGraceMilliseconds = 2000;

class ProofCommandFailed extends Data.TaggedError("ProofCommandFailed")<{
  readonly reason: "execution" | "output" | "cleanup";
}> {}

const stopProcess = Effect.fn(function* (child: Bun.Subprocess) {
  if (child.exitCode !== null) return;
  yield* Effect.try({
    try: () => child.kill("SIGTERM"),
    catch: () => new ProofCommandFailed({ reason: "cleanup" }),
  });
  const exited = yield* Effect.tryPromise({
    try: () => child.exited,
    catch: () => new ProofCommandFailed({ reason: "cleanup" }),
  }).pipe(Effect.timeoutOption(shutdownGraceMilliseconds));
  if (Option.isNone(exited)) {
    yield* Effect.try({
      try: () => child.kill("SIGKILL"),
      catch: () => new ProofCommandFailed({ reason: "cleanup" }),
    });
    yield* Effect.tryPromise({
      try: () => child.exited,
      catch: () => new ProofCommandFailed({ reason: "cleanup" }),
    });
  }
});

/** Stops an owned proof process, escalating after two seconds if graceful shutdown stalls. */
export const stopProofProcess = (child: Bun.Subprocess): Promise<void> =>
  Effect.runPromise(stopProcess(child));

/** Reads at most 1 MiB from a proof output pipe; the process owner closes the pipe on refusal. */
export const readProofOutput = Effect.fn(function* (stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";
  yield* Stream.fromReadableStream({
    evaluate: () => stream,
    onError: () => new ProofCommandFailed({ reason: "execution" }),
    releaseLockOnEnd: true,
  }).pipe(
    Stream.runForEach((chunk) => {
      bytes += chunk.byteLength;
      if (bytes > outputLimit) return Effect.fail(new ProofCommandFailed({ reason: "output" }));
      output += decoder.decode(chunk, { stream: true });
      return Effect.void;
    })
  );
  return output + decoder.decode();
});

/** Runs isolated proof tooling with a two-minute lifetime and a 1 MiB cap on each output pipe. */
export const runProofCommand = (
  args: ReadonlyArray<string>
): Effect.Effect<
  Readonly<{ stdout: string; stderr: string; exitCode: number }>,
  ProofCommandFailed | Cause.TimeoutError
> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => Bun.spawn([...args], { stdout: "pipe", stderr: "pipe" }),
      catch: () => new ProofCommandFailed({ reason: "execution" }),
    }),
    (child) =>
      Effect.all(
        {
          stdout: readProofOutput(child.stdout),
          stderr: readProofOutput(child.stderr),
          exitCode: Effect.tryPromise({
            try: () => child.exited,
            catch: () => new ProofCommandFailed({ reason: "execution" }),
          }),
        },
        { concurrency: "unbounded" }
      ),
    (child) => stopProcess(child).pipe(Effect.orDie)
  ).pipe(Effect.timeout("2 minutes"));
