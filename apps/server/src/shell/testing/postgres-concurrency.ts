import { Data, Deferred, Effect, Fiber, Option, Schema } from "effect";
import { type SqlConnection, type SqlError, SqlSchema } from "effect/unstable/sql";
import { MigrationSqlClient } from "~/shell/db/client";

const BackendIdentity = Schema.Struct({ pid: Schema.Int });
const BlockingObservation = Schema.Struct({ blocked: Schema.Boolean });

export class PostgreSQLScenarioFailure extends Data.TaggedError("PostgreSQLScenarioFailure")<{
  readonly phase: "held_transition_completed" | "contender_completed" | "lock_observation";
  readonly holderPid: Option.Option<number>;
}> {}

type ReadCommittedScenarioInput<HeldError, HeldRequirements, Result, Error, Requirements> =
  Readonly<{
    holdUncommitted: Effect.Effect<void, HeldError, HeldRequirements>;
    mustWaitThenContinue: Effect.Effect<Result, Error, Requirements>;
  }>;

const findBackendIdentity = Effect.fn("PostgreSQLScenario.findBackendIdentity")(function* () {
  const sql = yield* MigrationSqlClient;
  return yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: BackendIdentity,
    execute: () => sql`SELECT pg_backend_pid()::int AS pid`,
  })(undefined).pipe(Effect.orDie);
});

const observeBlocking = Effect.fn("PostgreSQLScenario.observeBlocking")(function* (
  observer: SqlConnection.Connection,
  holderPid: number
) {
  const rows = yield* observer.execute(
    `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE $1::int = ANY(pg_blocking_pids(pid))
       ) AS blocked`,
    [holderPid],
    undefined
  );
  return yield* Schema.decodeUnknownEffect(BlockingObservation)(rows[0]).pipe(
    Effect.map(({ blocked }) => blocked)
  );
}, Effect.orDie);

const waitUntilBlocked = (
  observer: SqlConnection.Connection,
  holderPid: number
): Effect.Effect<void> =>
  Effect.suspend(() =>
    observeBlocking(observer, holderPid).pipe(
      Effect.flatMap((blocked) =>
        blocked
          ? Effect.void
          : Effect.sleep("10 millis").pipe(Effect.andThen(waitUntilBlocked(observer, holderPid)))
      )
    )
  );

const boundedBlockObservation = (
  observer: SqlConnection.Connection,
  holderPid: number
): Effect.Effect<void, PostgreSQLScenarioFailure> =>
  waitUntilBlocked(observer, holderPid).pipe(
    Effect.timeoutOption("3 seconds"),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new PostgreSQLScenarioFailure({
              phase: "lock_observation",
              holderPid: Option.some(holderPid),
            })
          ),
        onSome: Effect.succeed,
      })
    )
  );

const completedBeforePhase = (
  phase: "held_transition_completed" | "contender_completed"
): PostgreSQLScenarioFailure => new PostgreSQLScenarioFailure({ phase, holderPid: Option.none() });

const startHeldTransition = Effect.fn("PostgreSQLScenario.startHeldTransition")(function* <
  HeldError,
  HeldRequirements,
>(
  holdUncommitted: Effect.Effect<void, HeldError, HeldRequirements>,
  held: Deferred.Deferred<number>,
  release: Deferred.Deferred<void>
) {
  const sql = yield* MigrationSqlClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const backend = yield* findBackendIdentity();
        yield* holdUncommitted;
        yield* Deferred.succeed(held, backend.pid);
        yield* Deferred.await(release);
      })
    )
    .pipe(Effect.forkChild({ startImmediately: true }));
});

/**
 * Runs the causal READ COMMITTED shape “hold one transition, prove the next waits, then commit”.
 * Connection ownership, lock observation, fiber failure propagation, deadlines, and cleanup stay
 * inside this test-only Module.
 */
export const runReadCommittedScenario = <HeldError, HeldRequirements, Result, Error, Requirements>(
  input: ReadCommittedScenarioInput<HeldError, HeldRequirements, Result, Error, Requirements>
): Effect.Effect<
  Result,
  HeldError | Error | PostgreSQLScenarioFailure | SqlError.SqlError,
  HeldRequirements | Requirements | MigrationSqlClient
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      const observer = yield* sql.reserve.pipe(Effect.orDie);
      const held = yield* Deferred.make<number>();
      const release = yield* Deferred.make<void>();
      const holderFiber = yield* startHeldTransition(input.holdUncommitted, held, release);
      return yield* Effect.gen(function* () {
        const holderPid = yield* Deferred.await(held).pipe(
          Effect.raceFirst(
            Fiber.join(holderFiber).pipe(
              Effect.flatMap(() => Effect.fail(completedBeforePhase("held_transition_completed")))
            )
          )
        );
        const contenderFiber = yield* input.mustWaitThenContinue.pipe(
          Effect.forkChild({ startImmediately: true })
        );
        yield* boundedBlockObservation(observer, holderPid).pipe(
          Effect.raceFirst(
            Fiber.join(contenderFiber).pipe(
              Effect.flatMap(() => Effect.fail(completedBeforePhase("contender_completed")))
            )
          )
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holderFiber);
        return yield* Fiber.join(contenderFiber);
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    })
  );
