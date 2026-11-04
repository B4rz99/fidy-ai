import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { RecoveryControllerClaim } from "./contract";
import { nativeRecoveryAdmission } from "./native.test-fixture";

it.effect(
  "drains only exactly settled native leases and suppresses response release after closing admission",
  () =>
    Effect.gen(function* () {
      const gate = yield* nativeRecoveryAdmission;
      const foreground = { epoch: "source-epoch", leaseId: "foreground" };
      const background = { epoch: "source-epoch", leaseId: "background" };
      expect(yield* Effect.tryPromise(() => gate.enter(foreground))).toBe(true);
      expect(yield* Effect.tryPromise(() => gate.enter(foreground))).toBe(false);
      expect(yield* Effect.tryPromise(() => gate.enter(background))).toBe(true);
      expect(yield* Effect.tryPromise(() => gate.complete({ ...foreground, epoch: "stale" }))).toBe(
        false
      );
      expect(
        yield* Effect.tryPromise(() =>
          gate.close({ epoch: "source-epoch", activationId: "activation" })
        )
      ).toMatchObject({ closed: true, leases: 2 });
      expect(yield* Effect.tryPromise(() => gate.enter({ ...foreground, leaseId: "late" }))).toBe(
        false
      );
      expect(yield* Effect.tryPromise(() => gate.complete(foreground))).toBe(false);
      expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({
        closed: true,
        leases: 1,
      });
      expect(yield* Effect.tryPromise(() => gate.complete(background))).toBe(false);
      expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({
        closed: true,
        leases: 0,
      });
    }).pipe(Effect.scoped)
);

it.effect(
  "pauses publishers while an earlier native queued job can still settle before final closure",
  () =>
    Effect.gen(function* () {
      const gate = yield* nativeRecoveryAdmission;
      const queuedJob = { epoch: "source-epoch", leaseId: "accepted-before-pause" };
      yield* Effect.tryPromise(() =>
        gate.pause({ epoch: queuedJob.epoch, activationId: "activation" })
      );
      expect(
        yield* Effect.tryPromise(() =>
          gate.enter({ epoch: queuedJob.epoch, leaseId: "new-publisher" })
        )
      ).toBe(false);
      expect(
        yield* Effect.tryPromise(() => gate.enterContinuation({ ...queuedJob, epoch: "stale" }))
      ).toBe(false);
      expect(yield* Effect.tryPromise(() => gate.enterContinuation(queuedJob))).toBe(true);
      expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({
        paused: true,
        closed: false,
        leases: 1,
      });
      expect(yield* Effect.tryPromise(() => gate.complete(queuedJob))).toBe(true);
      expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({
        paused: true,
        closed: false,
        leases: 0,
      });
      yield* Effect.tryPromise(() =>
        gate.close({ epoch: queuedJob.epoch, activationId: "activation" })
      );
      expect(
        yield* Effect.tryPromise(() =>
          gate.enterContinuation({ ...queuedJob, leaseId: "late-job" })
        )
      ).toBe(false);
      expect(
        yield* Effect.tryPromise(() =>
          gate.enter({ epoch: queuedJob.epoch, leaseId: "late-publisher" })
        )
      ).toBe(false);
    }).pipe(Effect.scoped)
);

it.effect(
  "retains one opaque controller through lost replies and never reacquires a released claim",
  () =>
    Effect.gen(function* () {
      const gate = yield* nativeRecoveryAdmission;
      const first = yield* Schema.decodeEffect(RecoveryControllerClaim)({
        epoch: "source-epoch",
        activationId: "activation",
        claimId: "18500000-0000-4000-8000-000000000011",
      });
      const second = yield* Schema.decodeEffect(RecoveryControllerClaim)({
        ...first,
        claimId: "18500000-0000-4000-8000-000000000012",
      });
      expect(yield* Effect.tryPromise(() => gate.acquireController(first))).toBe(true);
      expect(yield* Effect.tryPromise(() => gate.acquireController(first))).toBe(true);
      expect(yield* Effect.tryPromise(() => gate.acquireController(second))).toBe(false);
      yield* Effect.tryPromise(() =>
        gate.close({ epoch: first.epoch, activationId: first.activationId })
      );
      expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({
        controllerBusy: true,
      });
      expect(yield* Effect.tryPromise(() => gate.releaseController(first))).toBe(true);
      expect(yield* Effect.tryPromise(() => gate.acquireController(first))).toBe(false);
      expect(yield* Effect.tryPromise(() => gate.acquireController(second))).toBe(true);
      expect(yield* Effect.tryPromise(() => gate.releaseController(first))).toBe(true);
      expect(yield* Effect.tryPromise(() => gate.acquireController(first))).toBe(false);
      expect(yield* Effect.tryPromise(() => gate.inspect())).toMatchObject({
        controllerBusy: true,
      });
      expect(yield* Effect.tryPromise(() => gate.retainController(second))).toBe(true);
      expect(yield* Effect.tryPromise(() => gate.releaseController(second))).toBe(false);
      expect(yield* Effect.tryPromise(() => gate.acquireController(second))).toBe(false);
    }).pipe(Effect.scoped)
);
