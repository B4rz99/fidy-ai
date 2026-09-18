import { Effect, Option, Schema, type Scope } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import type { UserId } from "~/core/identity/reference";
import type { AdvisoryLockKey } from "~/shell/database/contract";
import { userTransactionInternal } from "./user-transaction";

const acquireSessionLock = Effect.fn(function* (lockKey: AdvisoryLockKey) {
  const sql = yield* SqlClient.SqlClient;
  const connection = yield* sql.reserve.pipe(Effect.orDie);
  yield* Effect.addFinalizer(() =>
    connection
      .executeRaw("SELECT pg_advisory_unlock(hashtextextended($1, $2))", [
        lockKey.value,
        lockKey.seed,
      ])
      .pipe(Effect.orDie)
  );
  yield* connection
    .executeRaw("SELECT pg_advisory_lock(hashtextextended($1, $2))", [lockKey.value, lockKey.seed])
    .pipe(Effect.orDie, Effect.interruptible);
});

/**
 * Linearizes one bounded forwarded-email provider/model call with Consent revocation without
 * retaining a database transaction. The reserved session is scoped to `use` and always unlocked.
 */
const withConsentExternalEffectLock = <A, E, R>(
  lockKey: AdvisoryLockKey,
  use: Effect.Effect<A, E, R>
): Effect.Effect<A, E, SqlClient.SqlClient | Exclude<R, Scope.Scope>> =>
  Effect.scoped(Effect.andThen(acquireSessionLock(lockKey), use));

/** Acquires one User-owned advisory lock inside the caller's active transaction. */
const withUserLockInScope = <A, E, R>(
  lockKey: AdvisoryLockKey,
  body: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey.value}, ${lockKey.seed}))
    `.pipe(Effect.orDie);
    return yield* body;
  });

/** Runs a body only when its transaction can acquire the lock without waiting. */
const tryWithUserLockInScope = <A, E, R>(
  lockKey: AdvisoryLockKey,
  body: Effect.Effect<A, E, R>
): Effect.Effect<Option.Option<A>, E, R | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { acquired } = yield* SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ acquired: Schema.Boolean }),
      execute: () => sql`
        SELECT pg_try_advisory_xact_lock(
          hashtextextended(${lockKey.value}, ${lockKey.seed})
        ) AS acquired
      `,
    })(undefined).pipe(Effect.orDie);
    return acquired ? Option.some(yield* body) : Option.none<A>();
  });

/** Runs a User-scoped body in the same transaction that owns the supplied advisory lock. */
const withUserLock = <A, E, R>(
  userId: UserId,
  lockKey: AdvisoryLockKey,
  body: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | SqlClient.SqlClient> =>
  userTransactionInternal.run(userId, withUserLockInScope(lockKey, body));

/** Private SQL implementation consumed only by the database operations interface. */
export const advisoryLockInternal = {
  tryWithUserLockInScope,
  withConsentExternalEffectLock,
  withUserLock,
  withUserLockInScope,
} as const;
