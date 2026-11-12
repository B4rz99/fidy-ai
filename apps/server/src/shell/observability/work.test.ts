import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { DisabledTelemetryResource, makeTelemetryService } from "./operations";
import {
  TelemetryAttempt,
  TelemetryGitRevision,
  TelemetryWorkDescriptor,
  type TelemetryWorkRecord,
  type TelemetryWorkSuccess,
} from "./contract";

const release = TelemetryGitRevision.make("0123456789abcdef0123456789abcdef01234567");

const options = {
  descriptor: TelemetryWorkDescriptor.make({
    release,
    operation: "worker.core.fetch",
    provider: Option.some("cloudflare-workers"),
    attempt: TelemetryAttempt.make(1),
  }),
  projectSuccess: (): TelemetryWorkSuccess => ({
    outcome: "succeeded",
    statusClass: Option.some("2xx"),
  }),
};

it.effect("exports only the closed Work-span projection and preserves success", () =>
  Effect.gen(function* () {
    const records: Array<TelemetryWorkRecord> = [];
    const telemetry = makeTelemetryService({
      ...DisabledTelemetryResource.adapter,
      exportWork: (record) => records.push(record),
    });
    const fiber = yield* telemetry
      .observeWork(options, Effect.sleep("25 millis").pipe(Effect.as("application-result")))
      .pipe(Effect.forkChild);

    yield* TestClock.adjust("25 millis");
    expect(yield* Fiber.join(fiber)).toBe("application-result");
    expect(records).toEqual([
      {
        release,
        operation: "worker.core.fetch",
        provider: "cloudflare-workers",
        statusClass: "2xx",
        outcome: "succeeded",
        attempt: 1,
        latencyMilliseconds: 25,
      },
    ]);
    expect(Object.keys(records[0] ?? {}).sort()).toEqual([
      "attempt",
      "latencyMilliseconds",
      "operation",
      "outcome",
      "provider",
      "release",
      "statusClass",
    ]);
  })
);

it.effect("preserves failure and interruption while exporting each exit once", () =>
  Effect.gen(function* () {
    const records: Array<TelemetryWorkRecord> = [];
    const telemetry = makeTelemetryService({
      ...DisabledTelemetryResource.adapter,
      exportWork: (record) => records.push(record),
    });
    const failure = yield* telemetry
      .observeWork(options, Effect.fail("application-failure"))
      .pipe(Effect.exit);
    const fiber = yield* telemetry.observeWork(options, Effect.never).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);
    const interrupted = yield* Fiber.await(fiber);

    expect(Exit.findErrorOption(failure)).toEqual(Option.some("application-failure"));
    expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true);
    expect(records.map(({ outcome }) => outcome)).toEqual(["failed", "interrupted"]);
  })
);

it.effect("contains synchronous export failure without changing authoritative Work", () =>
  Effect.gen(function* () {
    const telemetry = makeTelemetryService({
      ...DisabledTelemetryResource.adapter,
      exportWork: () => {
        throw new Error("export-failure-sentinel");
      },
    });

    expect(yield* telemetry.observeWork(options, Effect.succeed("application-result"))).toBe(
      "application-result"
    );
    const failure = yield* telemetry
      .observeWork(options, Effect.fail("application-failure"))
      .pipe(Effect.exit);
    expect(Exit.findErrorOption(failure)).toEqual(Option.some("application-failure"));
  })
);

it.effect(
  "drops a malformed success projection without exporting private metadata or repeating Work",
  () =>
    Effect.gen(function* () {
      const records: Array<TelemetryWorkRecord> = [];
      let executions = 0;
      const telemetry = makeTelemetryService({
        ...DisabledTelemetryResource.adapter,
        exportWork: (record) => records.push(record),
      });
      const result = yield* telemetry.observeWork(
        {
          ...options,
          projectSuccess: () =>
            new Proxy(options.projectSuccess(), {
              get: (target, key, receiver): unknown =>
                key === "outcome"
                  ? "private-projector-sentinel"
                  : Reflect.get(target, key, receiver),
            }),
        },
        Effect.sync(() => {
          executions += 1;
          return "authoritative-result";
        })
      );
      expect(result).toBe("authoritative-result");
      expect(executions).toBe(1);
      expect(records).toEqual([]);
    })
);

it.effect(
  "contains throwing projectors and exporters while preserving the complete Work Cause",
  () =>
    Effect.gen(function* () {
      let exports = 0;
      const telemetry = makeTelemetryService({
        ...DisabledTelemetryResource.adapter,
        exportWork: () => {
          exports += 1;
          throw new Error("private-export-sentinel");
        },
      });
      const throwingOptions = {
        ...options,
        projectSuccess: (): TelemetryWorkSuccess => {
          throw new Error("private-projection-sentinel");
        },
      };
      expect(yield* telemetry.observeWork(throwingOptions, Effect.succeed("completed"))).toBe(
        "completed"
      );
      expect(exports).toBe(0);
      const failure = new Error("private-typed-failure");
      const cause = Cause.combine(Cause.fail(failure), Cause.interrupt());
      const observed = yield* Effect.exit(telemetry.observeWork(options, Effect.failCause(cause)));
      expect(Exit.isFailure(observed) && observed.cause).toEqual(cause);
      expect(exports).toBe(1);
    })
);

it.effect(
  "projects mixed interruption as failure and keeps explicit interruption distinct from deadline failure",
  () =>
    Effect.gen(function* () {
      const records: Array<TelemetryWorkRecord> = [];
      const telemetry = makeTelemetryService({
        ...DisabledTelemetryResource.adapter,
        exportWork: (record) => records.push(record),
      });
      const deadline = new Cause.TimeoutError();
      yield* Effect.exit(telemetry.observeWork(options, Effect.fail(deadline)));
      yield* Effect.exit(
        telemetry.observeWork(
          options,
          Effect.failCause(Cause.combine(Cause.fail("failure"), Cause.interrupt()))
        )
      );
      const runExit = Effect.runPromiseExitWith(yield* Effect.context<never>());
      const interrupted = yield* Effect.tryPromise(() =>
        runExit(telemetry.observeWork(options, Effect.interrupt))
      );
      expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true);
      expect(records.map(({ outcome }) => outcome)).toEqual(["failed", "failed", "interrupted"]);
    })
);
