import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Clock, Effect, Option, Schema } from "effect";
import type { SmokeEnvironment } from "./contract";
import { SmokeWork } from "./internal/protocol";
import { SmokeBindingFailed, platform } from "./internal/platform";
import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workerRelease,
} from "../telemetry/operations";

const settleSyntheticSmoke = (db: D1Database, work: SmokeWork): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* platform({
        stage: "platform",
        tryWork: () =>
          db
            .prepare(
              "UPDATE release_smoke_probes SET status = 'passed' WHERE probe_id = ? AND git_revision = ? AND expires_at_ms > ? AND status = 'queued'"
            )
            .bind(work.probeId, work.gitRevision, now)
            .run(),
      });
    })
  );

/** Stable Workflow name and step: no provider call, model inference, or User-owned table. */
export class ReleaseSmokeWorkflowV1 extends WorkflowEntrypoint<SmokeEnvironment, unknown> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    const db = this.env.DB;
    const work = Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(SmokeWork)(event.payload);
      if (Option.isNone(decoded)) return yield* new SmokeBindingFailed({ stage: "platform" });
      yield* platform({
        stage: "platform",
        tryWork: () =>
          step.do("settle-synthetic-smoke-v1", () => settleSyntheticSmoke(db, decoded.value)),
      });
    });
    return observeWorkerPromise(() => Effect.runPromise(work), {
      environment: workerRelease(this.env),
      telemetry: cloudflareWorkerTelemetry,
      operation: "workflow.releaseSmoke",
    });
  }
}
