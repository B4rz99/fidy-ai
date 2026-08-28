import { expect, layer } from "@effect/vitest";
import { Cause, Data, Deferred, Effect, Exit, Fiber, Option } from "effect";
import { MigrationSqlClient } from "~/shell/db/client";
import { ApiHarness } from "./api-harness";
import { runReadCommittedScenario } from "./postgres-concurrency";

class HeldTransitionFailed extends Data.TaggedError("HeldTransitionFailed")<{}> {}

layer(ApiHarness, { excludeTestServices: true })("PostgreSQL concurrency scenarios", (it) => {
  it.effect("reports a held-transition failure instead of waiting for its phase signal", () =>
    Effect.gen(function* () {
      const exit = yield* runReadCommittedScenario({
        holdUncommitted: Effect.fail(new HeldTransitionFailed()),
        mustWaitThenContinue: Effect.never,
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toEqual(
          new HeldTransitionFailed()
        );
      }
    })
  );

  it.effect("reports a contender that completes without waiting", () =>
    Effect.gen(function* () {
      const exit = yield* runReadCommittedScenario({
        holdUncommitted: Effect.void,
        mustWaitThenContinue: Effect.succeed("completed"),
      }).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "PostgreSQLScenarioFailure",
          phase: "contender_completed",
        });
      }
    })
  );

  it.effect("releases a held PostgreSQL lock when the scenario is interrupted", () =>
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      const acquired = yield* Deferred.make<void>();
      const lockKey = 327_348;
      const scenario = yield* runReadCommittedScenario({
        holdUncommitted: sql`SELECT pg_advisory_xact_lock(${lockKey})`.pipe(
          Effect.tap(() => Deferred.succeed(acquired, undefined)),
          Effect.asVoid
        ),
        mustWaitThenContinue: Effect.never,
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(acquired);
      yield* Fiber.interrupt(scenario);

      const [probe] = yield* sql`
        SELECT pg_try_advisory_lock(${lockKey}) AS acquired
      `;
      expect(probe).toEqual({ acquired: true });
      yield* sql`SELECT pg_advisory_unlock(${lockKey})`;
    })
  );
});
