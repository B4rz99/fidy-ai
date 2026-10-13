import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { expect } from "vitest";
import { runProofCommand } from "./proof-command";

it.live("collects both proof output pipes and the actual exit", () =>
  Effect.gen(function* () {
    const result = yield* runProofCommand([
      process.execPath,
      "-e",
      'console.log("proof"); console.error("diagnostic"); process.exit(3)',
    ]);
    expect(result).toEqual({ stdout: "proof\n", stderr: "diagnostic\n", exitCode: 3 });
  })
);

it.live("refuses oversized proof output without retaining foreign diagnostic text", () =>
  Effect.gen(function* () {
    const failure = yield* runProofCommand([
      process.execPath,
      "-e",
      'process.stdout.write("x".repeat(1048577)); await Bun.sleep(60000)',
    ]).pipe(Effect.flip);
    expect(failure).toMatchObject({ _tag: "ProofCommandFailed", reason: "output" });
    expect(String(failure)).not.toContain("xxxxx");
  })
);

it.live("finishes interruption when the proof subprocess ignores SIGTERM", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.tryPromise(() =>
      import("node:fs/promises").then((fs) => fs.mkdtemp("/var/tmp/fidy-proof-command-"))
    );
    const marker = `${directory}/started`;
    yield* Effect.gen(function* () {
      const child = yield* Effect.forkScoped(
        runProofCommand([
          process.execPath,
          "-e",
          'process.on("SIGTERM", () => {}); await Bun.write(process.argv[1], "ready"); await Bun.sleep(60000)',
          marker,
        ])
      );
      while (!(yield* Effect.tryPromise(() => Bun.file(marker).exists()))) {
        yield* Effect.sleep("10 millis");
      }
      const interrupted = yield* Deferred.make<void>();
      const interruption = yield* Effect.forkScoped(
        Fiber.interrupt(child).pipe(Effect.andThen(Deferred.succeed(interrupted, undefined)))
      );
      yield* Effect.sleep("30 millis");
      expect(yield* Deferred.isDone(interrupted)).toBe(false);
      yield* Fiber.join(interruption);
      expect(yield* Deferred.isDone(interrupted)).toBe(true);
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.tryPromise(() =>
          import("node:fs/promises").then((fs) =>
            fs.rm(directory, { recursive: true, force: true })
          )
        )
      )
    );
  }).pipe(Effect.timeout("10 seconds"))
);
