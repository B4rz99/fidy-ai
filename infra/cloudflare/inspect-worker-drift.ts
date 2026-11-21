import { ReleaseHttpLive } from "./release-http";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import * as Drift from "alchemy/Alchemist/routes/drift";
import * as CliKit from "alchemy/Cli/CliKit";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Layer from "effect/Layer";
import { workerDriftReport } from "./worker-drift";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";

const services = Layer.mergeAll(
  AlchemyContextLive,
  CredentialsStoreLive,
  ProfileStoreLive,
  Layer.succeed(ArtifactStore, createArtifactStore()),
  ReleaseHttpLive,
  Layer.provideMerge(CliKit.CliKitInteraction, CliKit.layer())
).pipe(Layer.provideMerge(PlatformServices));

class DriftInspectionFailed extends Data.TaggedError("DriftInspectionFailed")<{
  readonly cause: unknown;
}> {}

const inspect = Effect.gen(function* () {
  const snapshot = yield* Drift.inspect({
    entrypoint: "alchemy-drift.run.ts",
    stage: "production",
  }).pipe(Effect.mapError((cause) => new DriftInspectionFailed({ cause })));

  return workerDriftReport(snapshot.repairPlan.native).join("\n");
}).pipe(
  Effect.timeout("45 seconds"),
  Effect.catchCause((cause) =>
    Effect.logWarning("Worker drift inspection failed", {
      interrupted: Cause.hasInterrupts(cause),
    }).pipe(
      Effect.as("Worker drift fields: Core unavailable\nWorker drift fields: Ingress unavailable")
    )
  )
);

if (import.meta.main) {
  BunRuntime.runMain(
    inspect.pipe(
      Effect.flatMap((report) =>
        Effect.tryPromise({
          try: () => Bun.write(Bun.stdout, `${report}\n`),
          catch: (cause) => new DriftInspectionFailed({ cause }),
        })
      ),
      Effect.provide(services),
      Effect.scoped
    )
  );
}
