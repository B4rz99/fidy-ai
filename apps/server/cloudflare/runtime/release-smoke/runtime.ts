import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Clock, Effect, Option, Schema } from "effect";
import type { SmokeCompletion, SmokeExecutorEnvironment } from "./contract";
import { SmokeWork, smokeExecutionId, smokeLifetimeMs } from "./internal/protocol";
import { verifySmokeDatabase } from "./internal/database";
import { SmokeBindingFailed, platform } from "./internal/platform";
import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workerRelease,
} from "../telemetry/operations";

/** Native execution output is the completion receipt; only immutable release metadata is retained. */
export class ReleaseSmokeWorkflowV2 extends WorkflowEntrypoint<SmokeExecutorEnvironment, unknown> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<SmokeCompletion> {
    const environment = this.env;
    const work = Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(SmokeWork)(event.payload);
      if (Option.isNone(decoded)) return yield* new SmokeBindingFailed({ stage: "platform" });
      const input = decoded.value;
      const now = yield* Clock.currentTimeMillis;
      if (
        input.expiresAtMs <= now ||
        input.expiresAtMs > now + smokeLifetimeMs ||
        event.instanceId !== smokeExecutionId(input) ||
        input.gitRevision !== environment.RELEASE_GIT_SHA ||
        input.contractDigest !== environment.CONTRACT_DIGEST
      ) {
        return yield* new SmokeBindingFailed({ stage: "identity" });
      }
      const context = yield* Effect.context<never>();
      return yield* platform({
        stage: "platform",
        tryWork: () =>
          step.do(
            "verify-synthetic-release-v2",
            { retries: { limit: 0, delay: "1 second" }, timeout: "30 seconds" },
            () =>
              Effect.runPromiseWith(context)(
                verifySmokeDatabase(environment.DB).pipe(
                  Effect.as({
                    probeId: input.probeId,
                    expiresAtMs: input.expiresAtMs,
                    coreVersionId: input.coreVersionId,
                    executor: {
                      gitRevision: environment.RELEASE_GIT_SHA,
                      contractDigest: environment.CONTRACT_DIGEST,
                      workerVersionId: environment.CF_VERSION_METADATA.id,
                    },
                  })
                )
              )
          ),
      });
    });
    return observeWorkerPromise(() => Effect.runPromise(work), {
      environment: workerRelease(environment),
      telemetry: cloudflareWorkerTelemetry,
      operation: "workflow.releaseSmoke",
    });
  }
}
