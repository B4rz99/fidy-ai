import { DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { BrowserLoginPairingId } from "~/core/browser-login/reference";
import {
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

const getStartAdmission = Effect.fn("BrowserLogin.getStartAdmission")(function* (
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
          COALESCE((SELECT CEIL(EXTRACT(EPOCH FROM (
            min(attempted_at) + interval '1 minute' - ${request.attemptedAt}::timestamptz
          )))::int FROM browser_login_start_attempts
            WHERE source_digest = ${request.sourceDigest}
              AND attempted_at > ${request.attemptedAt}::timestamptz - interval '1 minute'
          ), 1) AS "burstRetryAfterSeconds",
          COALESCE((SELECT CEIL(EXTRACT(EPOCH FROM (
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
              public_code, verifier_digest, created_at, expires_at
            ) VALUES (
              ${request.publicCode}, ${request.verifierDigest},
              ${request.createdAt}, ${request.expiresAt}
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

const findApprovalCandidate = Effect.fn("BrowserLogin.findApprovalCandidate")(function* (
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

const bindApprovalCandidate = Effect.fn("BrowserLogin.bindApprovalCandidate")(function* (
  sql: SqlClient.SqlClient,
  input: Readonly<{ userId: UserId; candidate: typeof ApprovalCandidate.Type }>,
  attemptedAt: DateTime.Utc
): Effect.fn.Return<void, ReturnType<typeof browserLoginApprovalRejected>> {
  const readyOrdinal = yield* SqlSchema.findOneOption({
    Request: UserId,
    Result: Schema.Struct({ createdOrdinal: Schema.BigIntFromString }),
    execute: (userId) => sql`
      SELECT created_ordinal AS "createdOrdinal" FROM browser_login_pairings
      WHERE user_id = ${userId}::uuid AND lifecycle = 'ready'
    `,
  })(input.userId).pipe(Effect.orDie);
  if (
    (yield* decideApprovalTransition({
      candidateOrdinal: input.candidate.createdOrdinal,
      readyOrdinal: Option.map(readyOrdinal, ({ createdOrdinal }) => createdOrdinal),
    })) === "reject"
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

        const publicCode = Schema.decodeUnknownOption(BrowserLoginPublicCodeInput)(
          input.publicCode
        );
        if (Option.isNone(publicCode)) return yield* browserLoginApprovalRejected();

        const candidate = yield* findApprovalCandidate(sql, publicCode.value, attemptedAt);
        if (Option.isNone(candidate)) return yield* browserLoginApprovalRejected();

        yield* bindApprovalCandidate(
          sql,
          { userId: input.userId, candidate: candidate.value },
          attemptedAt
        );
        return { pairingId: candidate.value.id, expiresAt: candidate.value.expiresAt };
      })
    );
  }
);
