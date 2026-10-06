import { BunFileSystem } from "@effect/platform-bun";
import { Data, Deferred, Effect, Fiber, FileSystem } from "effect";
import { expect, layer } from "@effect/vitest";
import { releaseCommand } from "./production-release";

class FixtureFailure extends Data.TaggedError("FixtureFailure")<{ cause: unknown }> {}
const wait = <A>(thunk: () => Promise<A>): Effect.Effect<A, FixtureFailure> =>
  Effect.tryPromise({ try: thunk, catch: (cause) => new FixtureFailure({ cause }) });
const awaitFile = (path: string): Effect.Effect<void, FixtureFailure> =>
  Effect.gen(function* () {
    while (!(yield* wait(() => Bun.file(path).exists()))) yield* Effect.sleep("10 millis");
  });

const exercise = Effect.fn(function* (lifetime: "read-only" | "started-write") {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectory({ prefix: "release-command-" });
  const release = `${directory}/release`;
  const started = `${directory}/started`;
  const terminated = `${directory}/terminated`;
  const finished = `${directory}/finished`;
  const script = `
      const directory = process.argv[1];
      process.on("SIGTERM", () => {
        Bun.write(directory + "/terminated", "terminated").then(() => process.exit(0));
      });
      await Bun.write(directory + "/started", String(process.pid));
      while (!(await Bun.file(directory + "/release").exists())) await Bun.sleep(10);
      await Bun.write(directory + "/finished", "finished");
      console.log("settled");
    `;
  yield* Effect.gen(function* () {
    const child = yield* Effect.forkScoped(
      releaseCommand({ args: ["bun", "-e", script, directory], lifetime })
    );
    yield* awaitFile(started);
    const interruptionFinished = yield* Deferred.make<void>();
    const interruption = yield* Effect.forkScoped(
      Fiber.interrupt(child).pipe(Effect.andThen(Deferred.succeed(interruptionFinished, undefined)))
    );
    if (lifetime === "read-only") {
      yield* Fiber.join(interruption);
      expect(yield* wait(() => Bun.file(terminated).exists())).toBe(true);
      expect(yield* wait(() => Bun.file(finished).exists())).toBe(false);
    } else {
      yield* Effect.sleep("30 millis");
      expect(yield* Deferred.isDone(interruptionFinished)).toBe(false);
      expect(yield* wait(() => Bun.file(terminated).exists())).toBe(false);
      yield* wait(() => Bun.write(release, "release"));
      yield* Fiber.join(interruption);
      expect(yield* wait(() => Bun.file(finished).exists())).toBe(true);
      expect(yield* wait(() => Bun.file(terminated).exists())).toBe(false);
    }
  }).pipe(
    Effect.ensuring(wait(() => Bun.write(release, "release")).pipe(Effect.orDie)),
    Effect.scoped,
    Effect.ensuring(fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie))
  );
}, Effect.timeout("10 seconds"));

layer(BunFileSystem.layer, { excludeTestServices: true })((it) => {
  for (const lifetime of ["read-only", "started-write"] as const) {
    it.effect(`owns actual child exit during ${lifetime} interruption`, () => exercise(lifetime));
  }
});
