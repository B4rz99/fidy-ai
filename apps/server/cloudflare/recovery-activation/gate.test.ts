import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
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
