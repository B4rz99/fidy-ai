import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { UserId, WhatsAppCallerReference } from "~/core/identity/reference";
import { withUserTransaction } from "./user-transaction";

type AdvisoryLockKey = {
  readonly value: string;
  readonly seed: number;
};

// Hosted-attempt acceptance orchestration belongs to #205; #204 covers this key at its DB seam.
/* istanbul ignore next */
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
  dashboard: (userId: UserId): AdvisoryLockKey => ({ value: userId, seed: 15 }),
  hostedAttempt: hostedAttemptLockKey,
  memories: (userId: UserId): AdvisoryLockKey => ({
    value: `memories:${userId}`,
    seed: 0,
  }),
  recurringSeries: (userId: UserId): AdvisoryLockKey => ({
    value: `recurring-series:${userId}`,
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
