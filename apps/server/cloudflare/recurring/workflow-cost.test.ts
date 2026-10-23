import { Config, Data, Effect, Option, Schema } from "effect";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { coordinatorTestDatabase } from "../d1-test-fixture";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";
import { readRecurringDigestSource } from "./operations";
import { seedDetectionHistory, userId } from "./detection-comparison.test-fixture";

class ComparisonFailed extends Data.TaggedError("ComparisonFailed")<{ message: string }> {}
const enabled =
  Effect.runSync(Config.String("INFRA_PERFORMANCE_MEASURE").pipe(Config.withDefault("0"))) === "1";
const Measurement = Schema.Struct({
  sample: Schema.Int,
  mode: Schema.Literals(["coordinator", "workflow"]),
  count: Schema.Int,
  groups: Schema.Int,
  steps: Schema.Int,
  elapsedMs: Schema.Finite,
});
const createRuntime = Effect.fn(function* () {
  const build = yield* Effect.tryPromise(() =>
    Bun.build({
      entrypoints: [new URL("./workflow-cost-worker.test-fixture.ts", import.meta.url).pathname],
      target: "browser",
      external: ["cloudflare:workers"],
    })
  );
  const output = build.outputs[0];
  if (!build.success || output === undefined) {
    return yield* new ComparisonFailed({ message: "Workflow experiment build failed" });
  }
  const script = yield* Effect.tryPromise(() => output.text());
  const runtime = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new Miniflare({
          workers: [
            {
              config: {
                name: "recurring-cost",
                type: "worker",
                compatibilityDate: "2026-09-08",
                exports: {
                  UserTransactionCoordinator: { type: "durable-object", storage: "sqlite" },
                },
                env: {
                  DB: { type: "d1", id: "recurring-cost" },
                  AI: { type: "json", value: { run: null } },
                  HOSTED_AI_MODEL: { type: "text", value: approvedWorkersAiModel },
                  USER_TRANSACTION_COORDINATOR: {
                    type: "durable-object",
                    worker: "recurring-cost",
                    exportName: "UserTransactionCoordinator",
                  },
                  EVALUATION: {
                    type: "workflow",
                    name: "recurring-cost",
                    worker: "recurring-cost",
                    exportName: "DetectionCostWorkflow",
                  },
                },
                manifest: {
                  mainModule: "index.mjs",
                  modules: {
                    "index.mjs": {
                      type: "esm",
                      contents:
                        'export { handler as default, UserTransactionCoordinator, DetectionCostWorkflow } from "./runtime.mjs";',
                    },
                    "runtime.mjs": { type: "esm", contents: script },
                  },
                },
              },
            },
          ],
        })
    ),
    (runtime) => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie)
  );

  return runtime;
});
const advance = Effect.fn(function* ({
  runtime,
  mode,
  steps,
  body,
  revision,
}: Readonly<{
  runtime: Miniflare;
  mode: (typeof Measurement.Type)["mode"];
  steps: number;
  body: string;
  revision: number;
}>) {
  if (mode === "coordinator") {
    const coordinator = yield* Effect.tryPromise(() =>
      runtime.getDurableObjectNamespace("USER_TRANSACTION_COORDINATOR")
    );
    for (let index = 0; index < steps; index++) {
      const response = yield* Effect.tryPromise(() =>
        coordinator.getByName(userId).fetch("https://coordinator/recurring-work", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        })
      );
      expect(response.status).toBe(200);
    }
  } else {
    const bindings = yield* Effect.tryPromise(() =>
      runtime.getBindings<{
        EVALUATION: Workflow<{ version: 1; userId: string; revision: number; steps: number }>;
      }>()
    );
    const instance = yield* Effect.tryPromise(() =>
      bindings.EVALUATION.create({
        id: `v1-1470-user-revision-${revision}`,
        params: { version: 1, userId, revision, steps },
      })
    );
    let complete = false;
    for (let poll = 0; poll < 1000; poll++) {
      const status = yield* Effect.tryPromise(() => instance.status());
      if (status.status === "errored") {
        return yield* new ComparisonFailed({
          message: "Native Workflow failed: " + status.error?.message,
        });
      }
      if (status.status === "complete") {
        expect(status.output).toBe(steps);
        complete = true;
        break;
      }
      yield* Effect.sleep("10 millis");
    }
    expect(complete).toBe(true);
  }
});
const measure = Effect.fn(function* (
  mode: (typeof Measurement.Type)["mode"],
  scenario: Readonly<{ count: number; groups: number }>
) {
  const runtime = yield* createRuntime();
  const db = yield* Effect.tryPromise(() => coordinatorTestDatabase({ runtime, binding: "DB" }));
  yield* seedDetectionHistory(db, scenario);
  const steps = Math.floor(scenario.count / 128) + 1 + scenario.groups + 2;
  const body = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ userId: Schema.String }))
  )({ userId });
  const start = performance.now();
  yield* advance({ runtime, mode, steps, body, revision: scenario.count });
  const elapsedMs = performance.now() - start;
  const result = yield* readRecurringDigestSource({ db, userId, cursor: Option.none() });
  expect(result.complete).toBe(true);
  expect(result.confirmations).toHaveLength(scenario.groups);
  return { ...scenario, mode, steps, elapsedMs };
});
it.skipIf(!enabled)(
  "compares native Workflow orchestration overhead with the existing User coordinator",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const measurements = [];
          for (const scenario of [
            { count: 128, groups: 8 },
            { count: 2000, groups: 32 },
          ]) {
            for (let sample = 0; sample < 3; sample++) {
              for (const mode of ["coordinator", "workflow"] as const) {
                measurements.push({ ...(yield* Effect.scoped(measure(mode, scenario))), sample });
              }
            }
          }
          const encoded = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Array(Measurement))
          )(measurements);
          yield* Effect.tryPromise(() =>
            Bun.write(
              new URL(
                "../../../../docs/research/recurring-workflow-measurements.json",
                import.meta.url
              ),
              encoded
            )
          );
        })
      )
    ),
  60000
);
