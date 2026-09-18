import { Context, Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { EmailAddress } from "~/core/email-authentication/model";
import type { UserId, WhatsAppCallerReference } from "~/core/identity/reference";
import type { AdvisoryLockKey, RuntimeRoleStatus } from "./contract";
import { advisoryLockInternal } from "~/shell/database/internal/advisory-lock";
import {
  readRuntimeAuthority,
  runtimeAuthorityIsUnsafe,
} from "~/shell/database/internal/runtime-authority";
import { userTransactionInternal } from "~/shell/database/internal/user-transaction";

type UserTransactionIsolation = "read-committed" | "repeatable-read";

/** Privileged database capability for migration-aware setup and operator operations. */
export class MigrationSqlClient extends Context.Service<MigrationSqlClient, SqlClient.SqlClient>()(
  "@fidy/server/shell/database/operations/MigrationSqlClient"
) {}

/**
 * Reads only the authority facts required to provision the fixed runtime role. The supplied SQL
 * client must use migration authority; infrastructure and invariant failures are defects.
 */
export const inspectRuntimeRole = (sql: SqlClient.SqlClient): Effect.Effect<RuntimeRoleStatus> =>
  readRuntimeAuthority(sql).pipe(
    Effect.map((authority): RuntimeRoleStatus => ({
      canLogin: authority.canLogin,
      hasUnsafeAuthority: runtimeAuthorityIsUnsafe(authority),
    })),
    Effect.orDie
  );

/**
 * Registry of process-side PostgreSQL advisory-lock keys. Every unrelated resource has a distinct
 * namespace or seed; callers cannot construct an unnamespaced lock by accident.
 */
export const advisoryLockKey = {
  keywordRules: (userId: UserId): AdvisoryLockKey => ({
    value: `keyword-rules:${userId}`,
    seed: 0,
  }),
  transactionReconciliation: (userId: UserId): AdvisoryLockKey => ({
    value: `transactions:reconciliation:${userId}`,
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
  backupRecoveryRotation: (userId: UserId): AdvisoryLockKey => ({
    value: `backup-recovery-rotation:${userId}`,
    seed: 0,
  }),
  subscriptionEnrollment: (userId: UserId): AdvisoryLockKey => ({
    value: `subscription-enrollment:${userId}`,
    seed: 0,
  }),
  emailReplacementCandidate: (emailAddress: EmailAddress): AdvisoryLockKey => ({
    value: `email-authentication:replacement-candidate:${emailAddress}`,
    seed: 0,
  }),
  dashboard: (userId: UserId): AdvisoryLockKey => ({ value: userId, seed: 15 }),
  memories: (userId: UserId): AdvisoryLockKey => ({
    value: `memories:${userId}`,
    seed: 0,
  }),
  consentSubject: (userId: UserId): AdvisoryLockKey => ({
    value: `consent-subject:${userId}`,
    seed: 0,
  }),
  consentExternalEffect: (userId: UserId): AdvisoryLockKey => ({
    value: `consent-external-effect:${userId}`,
    seed: 0,
  }),
  consentGate: (caller: WhatsAppCallerReference): AdvisoryLockKey => ({
    value: `consent-gate:${caller.businessPortfolioId}:${caller.businessScopedUserId}`,
    seed: 0,
  }),
  whatsAppBurst: (userId: UserId): AdvisoryLockKey => ({
    value: `whatsapp-burst:${userId}`,
    seed: 0,
  }),
} as const;

/**
 * Runs database work on one reserved connection inside a short transaction whose PostgreSQL User
 * context is local to that transaction. Nested calls may repeat the User but cannot switch it.
 * Commit, rollback, and interruption clear the context before connection reuse. Body failures stay
 * typed; transaction-management SQL failures are defects.
 */
export const withUserTransaction = Effect.fn("withUserTransaction")(function* <A, E, R>(
  userId: UserId,
  effect: Effect.Effect<A, E, R>,
  isolation: UserTransactionIsolation = "read-committed"
) {
  return yield* userTransactionInternal.run(userId, effect, isolation);
});

/**
 * Linearizes one bounded forwarded-email provider/model call with Consent revocation without
 * retaining a database transaction. The reserved session is scoped to `use` and always unlocked.
 */
export const withConsentExternalEffectLock = Effect.fn("withConsentExternalEffectLock")(function* <
  A,
  E,
  R,
>(userId: UserId, use: Effect.Effect<A, E, R>) {
  return yield* advisoryLockInternal.withConsentExternalEffectLock(
    advisoryLockKey.consentExternalEffect(userId),
    use
  );
});

/** Acquires one User-owned advisory lock inside the caller's active transaction. */
export const withUserLockInScope = Effect.fn("withUserLockInScope")(function* <A, E, R>(
  lockKey: AdvisoryLockKey,
  body: Effect.Effect<A, E, R>
) {
  return yield* advisoryLockInternal.withUserLockInScope(lockKey, body);
});

/** Runs a body only when its active transaction can acquire the lock without waiting. */
export const tryWithUserLockInScope = Effect.fn("tryWithUserLockInScope")(function* <A, E, R>(
  lockKey: AdvisoryLockKey,
  body: Effect.Effect<A, E, R>
) {
  return yield* advisoryLockInternal.tryWithUserLockInScope(lockKey, body);
});

/** Runs a User-scoped body in the same transaction that owns the supplied advisory lock. */
export const withUserLock = Effect.fn("withUserLock")(function* <A, E, R>(
  userId: UserId,
  lockKey: AdvisoryLockKey,
  body: Effect.Effect<A, E, R>
) {
  return yield* advisoryLockInternal.withUserLock(userId, lockKey, body);
});
