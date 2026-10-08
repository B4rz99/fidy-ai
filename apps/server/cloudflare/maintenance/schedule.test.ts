import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Logger, Schema } from "effect";
import { expect } from "vitest";
import type { TelemetryWorkRecord } from "../../src/shell/observability/contract";
import { ScheduledWorkFailed } from "./contract";
import { executeSchedule } from "./operations";
import { makeWorkerTelemetry, observeWorkerExecution } from "../runtime/telemetry/operations";

it.effect("attempts independent retention after a failed activity before reporting failure", () =>
  Effect.gen(function* () {
    const completed: Array<string> = [];
    const result = yield* executeSchedule([
      { operation: "browserPairing.email.dispatch", work: Effect.fail(undefined) },
      {
        operation: "audit.retention",
        work: Effect.sync(() => completed.push("audit")),
      },
      {
        operation: "ingestion.stagingSweep",
        work: Effect.sync(() => completed.push("staging")),
      },
    ]).pipe(Effect.exit);

    expect(completed).toEqual(["audit", "staging"]);
    assert.deepStrictEqual(result, Exit.fail(new ScheduledWorkFailed()));
  })
);

it.effect("contains typed failures and defects in bounded logs and one failed Work record", () =>
  Effect.gen(function* () {
    const privateDetail = "private-owner-material-sentinel";
    const logs: Array<unknown> = [];
    const logCauses: Array<Cause.Cause<unknown>> = [];
    const records: Array<TelemetryWorkRecord> = [];
    let retained = false;
    const logger = Logger.make<unknown, void>(({ message, cause }) => {
      logs.push(message);
      logCauses.push(cause);
    });
    const result = yield* executeSchedule([
      { operation: "browserPairing.email.dispatch", work: Effect.fail(privateDetail) },
      { operation: "billing.collection.dispatch", work: Effect.die(new Error(privateDetail)) },
      {
        operation: "audit.retention",
        work: Effect.sync(() => {
          retained = true;
        }),
      },
    ]).pipe(
      observeWorkerExecution({
        environment: { RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567" },
        telemetry: makeWorkerTelemetry((record) => records.push(record)),
        operation: "worker.core.scheduled",
      }),
      Effect.exit,
      Effect.provideService(Logger.CurrentLoggers, new Set([logger]))
    );

    expect(retained).toBe(true);
    assert.deepStrictEqual(result, Exit.fail(new ScheduledWorkFailed()));
    expect(logs).toEqual([
      [
        {
          component: "scheduled-work",
          operation: "browserPairing.email.dispatch",
          outcome: "failed",
        },
      ],
      [
        {
          component: "scheduled-work",
          operation: "billing.collection.dispatch",
          outcome: "failed",
        },
      ],
    ]);
    expect(logCauses.every((cause) => cause.reasons.length === 0)).toBe(true);
    expect(records).toEqual([
      {
        release: "0123456789abcdef0123456789abcdef01234567",
        operation: "worker.core.scheduled",
        provider: "cloudflare-workers",
        outcome: "failed",
        attempt: 1,
        latencyMilliseconds: 0,
      },
    ]);
    const exported = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Array(Schema.Unknown))
    )([logs, records]);
    expect(exported).not.toContain(privateDetail);
  })
);

it.effect("cancels active work and runs its cleanup without starting the next activity", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let released = false;
    let laterStarted = false;
    const records: Array<TelemetryWorkRecord> = [];
    const fiber = yield* executeSchedule([
      {
        operation: "browserPairing.email.dispatch",
        work: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              released = true;
            })
          )
        ),
      },
      {
        operation: "audit.retention",
        work: Effect.sync(() => {
          laterStarted = true;
        }),
      },
    ]).pipe(
      observeWorkerExecution({
        environment: { RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567" },
        telemetry: makeWorkerTelemetry((record) => records.push(record)),
        operation: "worker.core.scheduled",
      }),
      Effect.forkChild
    );

    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    const result = yield* Fiber.await(fiber);
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
    expect(released).toBe(true);
    expect(laterStarted).toBe(false);
    expect(records.map(({ outcome }) => outcome)).toEqual(["interrupted"]);
  })
);

it.effect("does not carry a prior invocation's failure into a successful schedule", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const schedule = executeSchedule([
      {
        operation: "audit.retention",
        work: Effect.suspend(() => {
          attempts += 1;
          return attempts === 1 ? Effect.fail(undefined) : Effect.void;
        }),
      },
    ]);

    assert.deepStrictEqual(yield* Effect.exit(schedule), Exit.fail(new ScheduledWorkFailed()));
    assert.deepStrictEqual(yield* Effect.exit(schedule), Exit.void);
    expect(attempts).toBe(2);
  })
);

it.effect("preserves an activity interruption and does not start later work", () =>
  Effect.gen(function* () {
    let released = false;
    let laterStarted = false;
    const result = yield* executeSchedule([
      {
        operation: "browserPairing.email.dispatch",
        work: Effect.interrupt.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              released = true;
            })
          )
        ),
      },
      {
        operation: "audit.retention",
        work: Effect.sync(() => {
          laterStarted = true;
        }),
      },
    ]).pipe(Effect.exit);

    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
    expect(released).toBe(true);
    expect(laterStarted).toBe(false);
  })
);
