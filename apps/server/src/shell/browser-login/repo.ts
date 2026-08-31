import { DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { BrowserLoginPairingId } from "~/core/browser-login/reference";
import {
  BrowserLoginPairingLifecycle,
  BrowserLoginPublicCode,
  BrowserLoginPublicCodeInput,
  decideApprovalTransition,
} from "~/core/browser-login/rules";
import { UserId } from "~/core/identity/reference";
import { getRejectedOperationAdmission } from "~/shell/audit/repo";
import { advisoryLockKey, withUserLockInScope } from "~/shell/db/advisory-lock";
import { browserLoginApprovalRateLimited, browserLoginApprovalRejected } from "./approval-errors";
import { BrowserLoginCapacityExceeded, BrowserLoginStartRateLimited } from "./errors";
import { browserLoginApprovalOperation } from "./operations";

const maximumBurstStarts = 5;
const maximumStartsPerWindow = 10;
const maximumLiveUnboundPairings = 10_000;

const StartPairingWrite = Schema.Struct({
  publicCode: BrowserLoginPublicCode,
  verifierDigest: Schema.Uint8Array,
  sourceDigest: Schema.Uint8Array,
  createdAt: Schema.DateTimeUtcFromDate,
  expiresAt: Schema.DateTimeUtcFromDate,
});

/** Digest-only persistence input from which challenge-generation inputs are derived. */
export type StartPairingWrite = typeof StartPairingWrite.Type;

const StartAdmission = Schema.Struct({
  burstCount: Schema.Int,
  windowCount: Schema.Int,
  liveCount: Schema.Int,
  burstRetryAfterSeconds: Schema.Int,
  windowRetryAfterSeconds: Schema.Int,
});

const getStartAdmission = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  input: Readonly<{ sourceDigest: Uint8Array; attemptedAt: DateTime.Utc }>
): Effect.fn.Return<typeof StartAdmission.Type, never> {
  return yield* SqlSchema.findOne({
    Request: Schema.Struct({
      sourceDigest: Schema.Uint8Array,
      attemptedAt: Schema.DateTimeUtcFromDate,
    }),
    Result: StartAdmission,
    execute: (request) => sql`
        SELECT
          (SELECT count(*)::int FROM browser_login_start_attempts
            WHERE source_digest = ${request.sourceDigest}
              AND attempted_at > ${request.attemptedAt}::timestamptz - interval '1 minute'
          ) AS "burstCount",
          (SELECT count(*)::int FROM browser_login_start_attempts
            WHERE source_digest = ${request.sourceDigest}
              AND attempted_at > ${request.attemptedAt}::timestamptz - interval '10 minutes'
          ) AS "windowCount",
          COALESCE((SELECT ROUND(EXTRACT(EPOCH FROM (
            min(attempted_at) + interval '1 minute' - ${request.attemptedAt}::timestamptz
          )))::int FROM browser_login_start_attempts
            WHERE source_digest = ${request.sourceDigest}
              AND attempted_at > ${request.attemptedAt}::timestamptz - interval '1 minute'
          ), 1) AS "burstRetryAfterSeconds",
          COALESCE((SELECT ROUND(EXTRACT(EPOCH FROM (
            min(attempted_at) + interval '10 minutes' - ${request.attemptedAt}::timestamptz
          )))::int FROM browser_login_start_attempts
            WHERE source_digest = ${request.sourceDigest}
              AND attempted_at > ${request.attemptedAt}::timestamptz - interval '10 minutes'
          ), 1) AS "windowRetryAfterSeconds",
          (SELECT count(*)::int FROM browser_login_pairings
            WHERE lifecycle = 'pending_approval'
              AND expires_at > ${request.attemptedAt}::timestamptz) AS "liveCount"
      `,
  })(input).pipe(Effect.orDie);
});

/** Removes start-address evidence after its rolling admission purpose expires. */
export const purgeExpiredAnonymousEvidence = Effect.fn(
  "BrowserLogin.purgeExpiredAnonymousEvidence"
)(function* (sql: SqlClient.SqlClient, attemptedAt: DateTime.Utc) {
  yield* sql`
      DELETE FROM browser_login_start_attempts
      WHERE attempted_at <= ${attemptedAt}::timestamptz - interval '10 minutes'
    `;
  yield* sql`
      UPDATE browser_login_pairings
      SET lifecycle = 'expired', expired_at = ${attemptedAt}
      WHERE lifecycle = 'pending_approval' AND expires_at <= ${attemptedAt}
    `;
}, Effect.orDie);

/** Inserts one unbound challenge and its digest-only admission evidence atomically. */
export const insertPendingBrowserLoginPairing = Effect.fn("BrowserLogin.insertPendingPairing")(
  function* (input: StartPairingWrite) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const lock = yield* SqlSchema.findOne({
            Request: Schema.Void,
            Result: Schema.Struct({ acquired: Schema.Boolean }),
            execute: () => sql`
              SELECT pg_try_advisory_xact_lock(hashtextextended('browser-login-start', 0)) AS acquired
            `,
          })(undefined).pipe(Effect.orDie);
          if (!lock.acquired) return yield* new BrowserLoginCapacityExceeded();
          // Admission evidence has no purpose after its rolling window. Expired pairings become
          // terminal evidence under the same lock; later retention can purge them by policy.
          yield* purgeExpiredAnonymousEvidence(sql, input.createdAt);
          const admission = yield* getStartAdmission(sql, {
            sourceDigest: input.sourceDigest,
            attemptedAt: input.createdAt,
          });
          if (admission.burstCount >= maximumBurstStarts) {
            return yield* new BrowserLoginStartRateLimited({
              retryAfterSeconds: Math.max(1, admission.burstRetryAfterSeconds),
            });
          }
          if (admission.windowCount >= maximumStartsPerWindow) {
            return yield* new BrowserLoginStartRateLimited({
              retryAfterSeconds: Math.max(1, admission.windowRetryAfterSeconds),
            });
          }
          if (admission.liveCount >= maximumLiveUnboundPairings) {
            return yield* new BrowserLoginCapacityExceeded();
          }
          return yield* SqlSchema.findOneOption({
            Request: StartPairingWrite,
            Result: Schema.Struct({ id: BrowserLoginPairingId }),
            execute: (request) => sql`
          WITH inserted_pairing AS (
            INSERT INTO browser_login_pairings (
              public_code, verifier_digest, created_at, expires_at, last_accepted_poll_at
            ) VALUES (
              ${request.publicCode}, ${request.verifierDigest},
              ${request.createdAt}, ${request.expiresAt}, ${request.createdAt}
            )
            ON CONFLICT (public_code)
              WHERE lifecycle IN ('pending_approval', 'ready') DO NOTHING
            RETURNING id
          ), recorded_attempt AS (
            INSERT INTO browser_login_start_attempts (source_digest, attempted_at)
            SELECT ${request.sourceDigest}, ${request.createdAt} FROM inserted_pairing
          )
          SELECT id FROM inserted_pairing
        `,
          })(input).pipe(Effect.orDie);
        })
      )
      .pipe(Effect.catchTag("SqlError", Effect.die));
  }
);

const ApprovalCandidate = Schema.Struct({
  id: BrowserLoginPairingId,
  createdAt: Schema.DateTimeUtcFromDate,
  createdOrdinal: Schema.BigIntFromString,
  expiresAt: Schema.DateTimeUtcFromDate,
});

const maximumApprovalFailures = 5;

const findApprovalCandidate = Effect.fn(function* (
  sql: SqlClient.SqlClient,
  publicCode: BrowserLoginPublicCode,
  attemptedAt: DateTime.Utc
): Effect.fn.Return<Option.Option<typeof ApprovalCandidate.Type>, never> {
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({
      publicCode: BrowserLoginPublicCode,
      attemptedAt: Schema.DateTimeUtcFromDate,
    }),
    Result: ApprovalCandidate,
    execute: (request) => sql`
        SELECT id, created_at AS "createdAt", created_ordinal AS "createdOrdinal",
          expires_at AS "expiresAt"
        FROM browser_login_pairings
        WHERE public_code = ${request.publicCode}
          AND lifecycle = 'pending_approval'
          AND expires_at > ${request.attemptedAt}::timestamptz
        FOR UPDATE
      `,
  })({ publicCode, attemptedAt }).pipe(Effect.orDie);
});

/** Reads one approvable pairing after the per-User owner lock, without retaining a row lock. */
export const findBrowserLoginApprovalCandidateInScope = Effect.fn(
  "BrowserLogin.findApprovalCandidateInScope"
)(function* (
  sql: SqlClient.SqlClient,
  pairingId: BrowserLoginPairingId,
  attemptedAt: DateTime.Utc
): Effect.fn.Return<Option.Option<typeof ApprovalCandidate.Type>, never, never> {
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({
      pairingId: BrowserLoginPairingId,
      attemptedAt: Schema.DateTimeUtcFromDate,
    }),
    Result: ApprovalCandidate,
    execute: (request) => sql`
        SELECT id, created_at AS "createdAt", created_ordinal AS "createdOrdinal",
          expires_at AS "expiresAt"
        FROM browser_login_pairings
        WHERE id = ${request.pairingId} AND lifecycle = 'pending_approval'
          AND expires_at > ${request.attemptedAt}::timestamptz
      `,
  })({ pairingId, attemptedAt }).pipe(Effect.orDie);
});

/** Locks one still-approvable pairing after recovery has taken its own row locks. */
export const lockBrowserLoginApprovalCandidateInScope = Effect.fn(
  "BrowserLogin.lockApprovalCandidateInScope"
)(function* (
  sql: SqlClient.SqlClient,
  pairingId: BrowserLoginPairingId,
  attemptedAt: DateTime.Utc
): Effect.fn.Return<Option.Option<typeof ApprovalCandidate.Type>, never, never> {
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({
      pairingId: BrowserLoginPairingId,
      attemptedAt: Schema.DateTimeUtcFromDate,
    }),
    Result: ApprovalCandidate,
    execute: (request) => sql`
        SELECT id, created_at AS "createdAt", created_ordinal AS "createdOrdinal",
          expires_at AS "expiresAt"
        FROM browser_login_pairings
        WHERE id = ${request.pairingId} AND lifecycle = 'pending_approval'
          AND expires_at > ${request.attemptedAt}::timestamptz
        FOR UPDATE
      `,
  })({ pairingId, attemptedAt }).pipe(Effect.orDie);
});

/** Performs BrowserLogin's owner transition for an already-locked approval candidate. */
export const approveLockedBrowserLoginPairingInScope = Effect.fn(
  "BrowserLogin.approveLockedPairingInScope"
)(function* (
  sql: SqlClient.SqlClient,
  input: Readonly<{ userId: UserId; candidate: typeof ApprovalCandidate.Type }>,
  attemptedAt: DateTime.Utc
): Effect.fn.Return<void, ReturnType<typeof browserLoginApprovalRejected>, never> {
  const readyOrdinal = yield* SqlSchema.findOneOption({
    Request: UserId,
    Result: Schema.Struct({ createdOrdinal: Schema.BigIntFromString }),
    execute: (userId) => sql`
      SELECT created_ordinal AS "createdOrdinal" FROM browser_login_pairings
      WHERE user_id = ${userId}::uuid AND lifecycle = 'ready'
    `,
  })(input.userId).pipe(Effect.orDie);
  if (
    decideApprovalTransition({
      candidateOrdinal: input.candidate.createdOrdinal,
      readyOrdinal: Option.map(readyOrdinal, ({ createdOrdinal }) => createdOrdinal),
    }) === "reject"
  ) {
    return yield* browserLoginApprovalRejected();
  }

  yield* sql`
      UPDATE browser_login_pairings
      SET lifecycle = 'superseded', superseded_at = ${attemptedAt},
        replacement_id = ${input.candidate.id}
      WHERE user_id = ${input.userId}::uuid AND lifecycle = 'ready'
    `.pipe(Effect.orDie);
  yield* sql`
      UPDATE browser_login_pairings
      SET user_id = ${input.userId}::uuid, lifecycle = 'ready', approved_at = ${attemptedAt}
      WHERE id = ${input.candidate.id} AND lifecycle = 'pending_approval'
    `.pipe(Effect.orDie);
});

/**
 * Binds one challenge inside the canonical User transaction. Prior metadata-only audit rejections
 * are the durable rolling-window evidence, so invalid submissions retain no code or secret.
 */
const LockedRedemptionCandidate = Schema.Struct({
  pairingId: BrowserLoginPairingId,
  userId: Schema.OptionFromNullOr(UserId),
  verifierDigest: Schema.Uint8Array,
  lifecycle: BrowserLoginPairingLifecycle,
  wrongVerifierAttempts: Schema.Int,
  minimumPollIntervalSeconds: Schema.Int,
  lastAcceptedPollAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  expiresAt: Schema.DateTimeUtcFromDate,
});

export type LockedRedemptionCandidate = typeof LockedRedemptionCandidate.Type;

/** Locks one candidate through the narrow pre-subject gateway for the surrounding transaction. */
export const lockBrowserLoginRedemptionCandidate = Effect.fn(
  "BrowserLogin.lockRedemptionCandidate"
)(function* (pairingId: BrowserLoginPairingId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: BrowserLoginPairingId,
    Result: LockedRedemptionCandidate,
    execute: (id) => sql`
        SELECT pairing_id AS "pairingId", user_id AS "userId",
          verifier_digest AS "verifierDigest", lifecycle,
          wrong_verifier_attempts AS "wrongVerifierAttempts",
          minimum_poll_interval_seconds AS "minimumPollIntervalSeconds",
          last_accepted_poll_at AS "lastAcceptedPollAt", expires_at AS "expiresAt"
        FROM fidy_lock_browser_login_pairing(${id}::uuid)
      `,
  })(pairingId).pipe(Effect.orDie);
});

const GatewayChanged = Schema.Struct({ changed: Schema.Boolean });

/** Persists one accepted poll while the caller holds the pairing row lock. */
export const acceptBrowserLoginPoll = Effect.fn("BrowserLogin.acceptPoll")(function* (
  pairingId: BrowserLoginPairingId,
  acceptedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const { changed } = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: GatewayChanged,
    execute: () => sql`
      SELECT fidy_accept_browser_login_poll(${pairingId}::uuid, ${acceptedAt}) AS changed
    `,
  })(undefined).pipe(Effect.orDie);
  return changed;
});

/** Persists server-directed slowdown while the caller holds the pairing row lock. */
export const slowBrowserLoginPoll = Effect.fn("BrowserLogin.slowPoll")(function* (
  pairingId: BrowserLoginPairingId,
  minimumPollIntervalSeconds: number
) {
  const sql = yield* SqlClient.SqlClient;
  const { changed } = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: GatewayChanged,
    execute: () => sql`
      SELECT fidy_slow_browser_login_poll(
        ${pairingId}::uuid, ${minimumPollIntervalSeconds}::integer
      ) AS changed
    `,
  })(undefined).pipe(Effect.orDie);
  return changed;
});

/** Persists one bounded verifier refusal while the caller holds the pairing row lock. */
export const rejectBrowserLoginVerifier = Effect.fn("BrowserLogin.rejectVerifier")(function* (
  input: Readonly<{
    pairingId: BrowserLoginPairingId;
    wrongVerifierAttempts: number;
    lifecycle: "pending_approval" | "ready" | "invalidated";
    rejectedAt: DateTime.Utc;
  }>
) {
  const sql = yield* SqlClient.SqlClient;
  const { changed } = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: GatewayChanged,
    execute: () => sql`
      SELECT fidy_reject_browser_login_verifier(
        ${input.pairingId}::uuid,
        ${input.wrongVerifierAttempts}::integer,
        ${input.lifecycle}::text,
        ${input.rejectedAt}
      ) AS changed
    `,
  })(undefined).pipe(Effect.orDie);
  return changed;
});

/** Expires one active pairing while the caller holds its row lock. */
export const expireBrowserLoginPairing = Effect.fn("BrowserLogin.expirePairing")(function* (
  pairingId: BrowserLoginPairingId,
  expiredAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const { changed } = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: GatewayChanged,
    execute: () => sql`
      SELECT fidy_expire_browser_login_pairing(${pairingId}::uuid, ${expiredAt}) AS changed
    `,
  })(undefined).pipe(Effect.orDie);
  return changed;
});

/** Binds one already-proved pairing by owner identity inside the caller's ordered transaction. */
export const approveBrowserLoginPairingIdInScope = Effect.fn(
  "BrowserLogin.approvePairingIdInScope"
)(function* (
  input: Readonly<{ userId: UserId; pairingId: BrowserLoginPairingId; attemptedAt: DateTime.Utc }>
) {
  const sql = yield* SqlClient.SqlClient;
  const candidate = yield* lockBrowserLoginApprovalCandidateInScope(
    sql,
    input.pairingId,
    input.attemptedAt
  );
  if (Option.isNone(candidate)) return Option.none<DateTime.Utc>();
  const approvedAt = yield* DateTime.now;
  if (DateTime.isGreaterThanOrEqualTo(approvedAt, candidate.value.expiresAt)) {
    yield* expireBrowserLoginPairing(candidate.value.id, approvedAt);
    return Option.none<DateTime.Utc>();
  }
  yield* approveLockedBrowserLoginPairingInScope(
    sql,
    { userId: input.userId, candidate: candidate.value },
    approvedAt
  );
  return Option.some(approvedAt);
});

export const approveBrowserLoginPairingInScope = Effect.fn("BrowserLogin.approvePairingInScope")(
  function* (input: Readonly<{ userId: UserId; publicCode: string }>) {
    const sql = yield* SqlClient.SqlClient;
    const attemptedAt = yield* DateTime.now;

    return yield* withUserLockInScope(
      advisoryLockKey.browserLoginApproval(input.userId),
      Effect.gen(function* () {
        const admission = yield* getRejectedOperationAdmission(sql, {
          userId: input.userId,
          operation: browserLoginApprovalOperation,
          attemptedAt,
          windowMinutes: 10,
        });
        if (admission.rejectionCount >= maximumApprovalFailures) {
          return yield* browserLoginApprovalRateLimited(Math.max(1, admission.retryAfterSeconds));
        }

        const publicCode = Schema.decodeOption(BrowserLoginPublicCodeInput)(input.publicCode);
        if (Option.isNone(publicCode)) return yield* browserLoginApprovalRejected();

        const candidate = yield* findApprovalCandidate(sql, publicCode.value, attemptedAt);
        if (Option.isNone(candidate)) return yield* browserLoginApprovalRejected();

        yield* approveLockedBrowserLoginPairingInScope(
          sql,
          { userId: input.userId, candidate: candidate.value },
          attemptedAt
        );
        return { pairingId: candidate.value.id, expiresAt: candidate.value.expiresAt };
      })
    );
  }
);
