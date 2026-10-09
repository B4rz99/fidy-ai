import * as Alchemist from "alchemy/Alchemist";
import * as Apply from "alchemy/Apply";
import { Cause, Config, Data, Effect, Option, Schema } from "effect";
import { releaseCommand } from "./production-release";

class ResourceReleaseFailed extends Data.TaggedError("ResourceReleaseFailed")<{
  message: string;
}> {}

const Phase = Schema.Literals(["upload", "retire"]);

// Alchemy keeps pending deletions in its state; retirement never reconciles the verified resources.
const releaseResources = Effect.fn(function* (phase: typeof Phase.Type) {
  const actions = yield* Config.String("GITHUB_ACTIONS").pipe(Config.withDefault(""));
  const ref = yield* Config.String("GITHUB_REF").pipe(Config.withDefault(""));
  const profile = yield* Config.String("ALCHEMY_PROFILE").pipe(Config.option);
  if (actions !== "true" || ref !== "refs/heads/trunk") {
    return yield* new ResourceReleaseFailed({
      message: "Resource release requires the protected trunk Production workflow.",
    });
  }
  const snapshot = yield* Alchemist.Stack.plan({
    target: {
      entrypoint: "alchemy.run.ts",
      stage: "production",
      profile: Option.getOrUndefined(profile),
    },
    operation: "deploy",
    updateStateStore: true,
  }).pipe(
    Effect.mapError(() => new ResourceReleaseFailed({ message: "Resource planning failed." }))
  );
  if (phase === "retire") {
    // Recheck after planning, immediately before the first destructive operation.
    yield* releaseCommand({
      args: ["bun", "production-release.ts", "verify-retirement"],
      lifetime: "read-only",
    }).pipe(
      Effect.mapError(
        () =>
          new ResourceReleaseFailed({
            message:
              "Resource retirement refused: verified Worker traffic changed or is unreadable.",
          })
      )
    );
  }
  return yield* Apply.apply(snapshot.native, {
    deletions: phase === "upload" ? "defer" : "only",
  }).pipe(
    Effect.provide(snapshot.session.context),
    Effect.uninterruptible,
    Effect.asVoid,
    Effect.catchTag("DeletionPhaseError", (error) =>
      Effect.fail(new ResourceReleaseFailed({ message: error.message }))
    ),
    Effect.mapError((error) =>
      error._tag === "ResourceReleaseFailed"
        ? error
        : new ResourceReleaseFailed({
            message: "Alchemy resource operation failed; inspect release state.",
          })
    )
  );
});

if (import.meta.main) {
  const program = Effect.gen(function* () {
    const phase = yield* Schema.decodeUnknownEffect(Phase)(process.argv[2]);
    yield* releaseResources(phase);
    yield* Effect.sync(() => process.stdout.write(`Production resource ${phase} passed.\n`));
  }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped);
  await Effect.runPromise(
    program.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const failure = Cause.findErrorOption(cause);
          const message =
            Option.isSome(failure) && failure.value._tag === "ResourceReleaseFailed"
              ? failure.value.message
              : "Production resource release failed; inspect release state.";
          process.stderr.write(`${message}\n`);
          process.exitCode = 1;
        })
      )
    )
  );
}
