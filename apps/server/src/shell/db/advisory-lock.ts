import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { UserId, WhatsAppCallerReference } from "~/core/identity/reference";
import { withUserTransaction } from "./user-transaction";

type AdvisoryLockKey = {
  readonly value: string;
  readonly seed: number;
};

const hostedAttemptLockKey = (userId: UserId): AdvisoryLockKey => ({
  value: `hosted-attempt:${userId}`,
  seed: 0,
});

/**
 * Registry of process-side PostgreSQL advisory-lock keys. Every unrelated resource has a distinct
 * namespace or seed; WhatsApp admission intentionally hashes the bare UserId to share its key with
 * the database claim function.
 */
export const advisoryLockKey = {
  keywordRules: (userId: UserId): AdvisoryLockKey => ({
    value: `keyword-rules:${userId}`,
    seed: 0,
  }),
  budgets: (userId: UserId): AdvisoryLockKey => ({
    value: `budgets:${userId}`,
    seed: 0,
  }),
  browserLoginApproval: (userId: UserId): AdvisoryLockKey => ({
    value: `browser-login-approval:${userId}`,
    seed: 0,
  }),
  dashboard: (userId: UserId): AdvisoryLockKey => ({ value: userId, seed: 15 }),
  hostedAttempt: hostedAttemptLockKey,
  memories: (userId: UserId): AdvisoryLockKey => ({
    value: `memories:${userId}`,
    seed: 0,
  }),
  consentSubject: (userId: UserId): AdvisoryLockKey => ({
    value: `consent-subject:${userId}`,
    seed: 0,
  }),
  consentGate: (caller: WhatsAppCallerReference): AdvisoryLockKey => ({
    value: `consent-gate:${caller.businessPortfolioId}:${caller.businessScopedUserId}`,
    seed: 0,
  }),
  whatsAppAdmission: (userId: string): AdvisoryLockKey => ({ value: userId, seed: 0 }),
} as const;

const acquireUserTurnLock = Effect.fn("acquireUserTurnLock")(function* (userId: UserId) {
  const sql = yield* SqlClient.SqlClient;
  const connection = yield* sql.reserve.pipe(Effect.orDie);
  const lockKey = hostedAttemptLockKey(userId);
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
 * Serializes one User's hosted work across runtime instances for exactly the duration of `use`.
 * Unlike the transaction-scoped locks above this one is held on a reserved connection, so it spans
 * the several transactions one hosted Turn commits. The unlock finalizer is registered before the
 * lock is taken so an interrupted wait still releases it, and waiting stays interruptible so a
 * cancelled Turn stops queueing instead of blocking the next one. Taking the lock is not reachable
 * apart from the work it guards, so no caller can hold one past the flow that acquired it.
 */
export const withUserTurnLock = Effect.fn("withUserTurnLock")(function* <A, E, R>(
  userId: UserId,
  use: Effect.Effect<A, E, R>
) {
  return yield* Effect.scoped(Effect.andThen(acquireUserTurnLock(userId), use));
});

/** Acquires one User-owned advisory lock inside the caller's active transaction. */
export const withUserLockInScope = Effect.fn("withUserLockInScope")(function* <A, E, R>(
  lockKey: AdvisoryLockKey,
  body: Effect.Effect<A, E, R>
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${lockKey.value}, ${lockKey.seed}))
  `.pipe(Effect.orDie);
  return yield* body;
});

/** Runs a User-scoped body in the same transaction that owns the supplied advisory lock. */
export const withUserLock = Effect.fn("withUserLock")(function* <A, E, R>(
  userId: UserId,
  lockKey: AdvisoryLockKey,
  body: Effect.Effect<A, E, R>
) {
  return yield* withUserTransaction(userId, withUserLockInScope(lockKey, body));
});
