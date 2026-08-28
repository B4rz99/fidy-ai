import { type DateTime, Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { BrowserLoginPairingId } from "~/core/browser-login/reference";
import type { BrowserLoginPublicCode } from "~/core/browser-login/rules";
import { UserId } from "~/core/identity/reference";
import type { WebSessionId } from "~/core/web-session/reference";
import {
  BackupRecoveryDigest,
  type SupportOperatorId,
  type SupportRecoveryCaseEvent,
  type SupportRecoveryCaseEventId,
  SupportRecoveryCaseId,
} from "~/core/recovery/model";

/** Recovery-owned digest installation inside onboarding's already-open transaction. */
export const installBackupRecoveryCredentialInScope = Effect.fn(
  "Recovery.installBackupRecoveryCredentialInScope"
)(function* (
  input: Readonly<{
    userId: UserId;
    codeDigest: BackupRecoveryDigest;
    createdAt: DateTime.Utc;
  }>
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO backup_recovery_credentials (user_id, code_digest, created_at)
    VALUES (${input.userId}, ${input.codeDigest}, ${input.createdAt})
  `;
}, Effect.orDie);

/** Idempotent digest fixture write; production onboarding never calls this operation. */
export const upsertDevelopmentBackupRecoveryCredentialInScope = Effect.fn(
  "Recovery.upsertDevelopmentBackupRecoveryCredentialInScope"
)(function* (
  input: Readonly<{
    userId: UserId;
    codeDigest: BackupRecoveryDigest;
    createdAt: DateTime.Utc;
  }>
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO backup_recovery_credentials (user_id, code_digest, created_at)
    VALUES (${input.userId}, ${input.codeDigest}, ${input.createdAt})
    ON CONFLICT (user_id) DO UPDATE SET code_digest = EXCLUDED.code_digest,
      created_at = EXCLUDED.created_at, consumed_at = NULL, consumed_by_case_id = NULL,
      revision = backup_recovery_credentials.revision + 1
  `;
}, Effect.orDie);

const Admission = Schema.Struct({
  operatorMinute: Schema.Int,
  operatorHour: Schema.Int,
  globalMinute: Schema.Int,
  globalHour: Schema.Int,
  operatorMinuteRetry: Schema.Int,
  operatorHourRetry: Schema.Int,
  globalMinuteRetry: Schema.Int,
  globalHourRetry: Schema.Int,
});

/** Authenticated admission outcome returned before any support request body is decoded. */
export type SupportRecoveryAdmission =
  | Readonly<{ _tag: "Admitted" }>
  | Readonly<{ _tag: "Limited"; retryAfterSeconds: number }>;

const operatorMinuteLimit = 5;
const operatorHourLimit = 20;
const globalMinuteLimit = 20;
const globalHourLimit = 100;

const retryForExceededBounds = (admission: typeof Admission.Type): number => {
  const retries = [
    admission.operatorMinute > operatorMinuteLimit ? admission.operatorMinuteRetry : 0,
    admission.operatorHour > operatorHourLimit ? admission.operatorHourRetry : 0,
    admission.globalMinute > globalMinuteLimit ? admission.globalMinuteRetry : 0,
    admission.globalHour > globalHourLimit ? admission.globalHourRetry : 0,
  ];
  return Math.max(1, ...retries);
};

const recordAdmission = Effect.fn("Recovery.recordAdmission")(function* (
  operatorId: SupportOperatorId,
  attemptedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`SELECT pg_advisory_xact_lock(hashtextextended('support-recovery:admission', 0))`;
  yield* sql`
    DELETE FROM support_recovery_admission_attempts
    WHERE attempted_at <= ${attemptedAt}::timestamptz - interval '1 hour'
  `;
  yield* sql`
    INSERT INTO support_recovery_admission_attempts (
      operator_issuer, operator_subject, attempted_at, invocation_count
    ) VALUES (
      ${operatorId.issuer}, ${operatorId.subject}, ${attemptedAt}, 1
    ) ON CONFLICT (operator_issuer, operator_subject, attempted_at)
    DO UPDATE SET invocation_count = support_recovery_admission_attempts.invocation_count + 1
  `;
});

const readAdmission = Effect.fn("Recovery.readAdmission")(function* (
  operatorId: SupportOperatorId,
  attemptedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Admission,
    execute: () => sql`
      SELECT
        COALESCE(sum(invocation_count) FILTER (
          WHERE operator_issuer = ${operatorId.issuer} AND operator_subject = ${operatorId.subject}
            AND attempted_at > ${attemptedAt}::timestamptz - interval '1 minute'
        ), 0)::int AS "operatorMinute",
        COALESCE(sum(invocation_count) FILTER (
          WHERE operator_issuer = ${operatorId.issuer} AND operator_subject = ${operatorId.subject}
            AND attempted_at > ${attemptedAt}::timestamptz - interval '1 hour'
        ), 0)::int AS "operatorHour",
        COALESCE(sum(invocation_count) FILTER (
          WHERE attempted_at > ${attemptedAt}::timestamptz - interval '1 minute'
        ), 0)::int AS "globalMinute",
        COALESCE(sum(invocation_count), 0)::int AS "globalHour",
        COALESCE(CEIL(EXTRACT(EPOCH FROM (
          min(attempted_at) FILTER (
            WHERE operator_issuer = ${operatorId.issuer} AND operator_subject = ${operatorId.subject}
              AND attempted_at > ${attemptedAt}::timestamptz - interval '1 minute'
          ) + interval '1 minute' - ${attemptedAt}::timestamptz
        )))::int, 1) AS "operatorMinuteRetry",
        COALESCE(CEIL(EXTRACT(EPOCH FROM (
          min(attempted_at) FILTER (
            WHERE operator_issuer = ${operatorId.issuer} AND operator_subject = ${operatorId.subject}
              AND attempted_at > ${attemptedAt}::timestamptz - interval '1 hour'
          ) + interval '1 hour' - ${attemptedAt}::timestamptz
        )))::int, 1) AS "operatorHourRetry",
        COALESCE(CEIL(EXTRACT(EPOCH FROM (
          min(attempted_at) FILTER (
            WHERE attempted_at > ${attemptedAt}::timestamptz - interval '1 minute'
          ) + interval '1 minute' - ${attemptedAt}::timestamptz
        )))::int, 1) AS "globalMinuteRetry",
        COALESCE(CEIL(EXTRACT(EPOCH FROM (
          min(attempted_at) + interval '1 hour' - ${attemptedAt}::timestamptz
        )))::int, 1) AS "globalHourRetry"
      FROM support_recovery_admission_attempts
    `,
  })(undefined);
});

/** Counts every authenticated invocation and applies all approved rolling limits atomically. */
export const admitSupportRecoveryInvocation = Effect.fn("Recovery.admitInvocation")(function* (
  operatorId: SupportOperatorId,
  attemptedAt: DateTime.Utc
): Effect.fn.Return<SupportRecoveryAdmission, never, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* recordAdmission(operatorId, attemptedAt);
        const admission = yield* readAdmission(operatorId, attemptedAt);
        const admitted =
          admission.operatorMinute <= operatorMinuteLimit &&
          admission.operatorHour <= operatorHourLimit &&
          admission.globalMinute <= globalMinuteLimit &&
          admission.globalHour <= globalHourLimit;
        return admitted
          ? { _tag: "Admitted" as const }
          : { _tag: "Limited" as const, retryAfterSeconds: retryForExceededBounds(admission) };
      }).pipe(Effect.orDie)
    )
    .pipe(Effect.catchTag("SqlError", Effect.die));
});

const ResolvedSupportRecovery = Schema.Struct({
  userId: UserId,
  credentialRevision: Schema.Int,
  pairingId: BrowserLoginPairingId,
  pairingExpiresAt: Schema.DateTimeUtcFromDate,
});
export type ResolvedSupportRecovery = typeof ResolvedSupportRecovery.Type;

/** Narrow pre-subject resolver; no lock or Secret leaves this call. */
export const resolveSupportRecovery = Effect.fn("Recovery.resolveCandidate")(function* (
  codeDigest: BackupRecoveryDigest,
  publicCode: BrowserLoginPublicCode
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: ResolvedSupportRecovery,
    execute: () => sql`
      SELECT user_id AS "userId", credential_revision AS "credentialRevision",
        pairing_id AS "pairingId", pairing_expires_at AS "pairingExpiresAt"
      FROM fidy_resolve_support_recovery(${codeDigest}, ${publicCode})
    `,
  })(undefined).pipe(Effect.orDie);
});

const LockedCredential = Schema.Struct({
  codeDigest: Schema.OptionFromNullOr(BackupRecoveryDigest),
  revision: Schema.Int,
  consumedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
});
export type LockedCredential = typeof LockedCredential.Type;

/** Locks the candidate credential and rechecks its revision under User RLS. */
export const lockBackupRecoveryCredential = Effect.fn("Recovery.lockCredential")(function* (
  userId: UserId
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: UserId,
    Result: LockedCredential,
    execute: (id) => sql`
      SELECT code_digest AS "codeDigest", revision, consumed_at AS "consumedAt"
      FROM backup_recovery_credentials WHERE user_id = ${id} FOR UPDATE
    `,
  })(userId).pipe(Effect.orDie);
});

const OpenCase = Schema.Struct({
  id: SupportRecoveryCaseId,
  pairingId: BrowserLoginPairingId,
  credentialRevision: Schema.Int,
  expiresAt: Schema.DateTimeUtcFromDate,
  rejectionCount: Schema.Int,
  nextOrdinal: Schema.Int,
});
export type OpenSupportRecoveryCase = typeof OpenCase.Type;

/** Finds and locks the User's only open case, deriving counts from append-only rows. */
export const findOpenSupportRecoveryCase = Effect.fn("Recovery.findOpenCase")(function* (
  userId: UserId
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: UserId,
    Result: OpenCase,
    execute: (id) => sql`
      WITH locked_case AS MATERIALIZED (
        SELECT id, pairing_id, credential_revision, expires_at
        FROM support_recovery_cases
        WHERE user_id = ${id} AND lifecycle = 'open'
        FOR UPDATE
      )
      SELECT recovery_case.id, recovery_case.pairing_id AS "pairingId",
        recovery_case.credential_revision AS "credentialRevision",
        recovery_case.expires_at AS "expiresAt",
        count(event.id) FILTER (
          WHERE event.action = 'decide' AND event.outcome = 'rejected'
        )::int AS "rejectionCount",
        (COALESCE(max(event.ordinal), 0) + 1)::int AS "nextOrdinal"
      FROM locked_case recovery_case
      LEFT JOIN support_recovery_case_events event ON event.case_id = recovery_case.id
      GROUP BY recovery_case.id, recovery_case.pairing_id,
        recovery_case.credential_revision, recovery_case.expires_at
    `,
  })(userId).pipe(Effect.orDie);
});

/** Whether this pairing already owns its one lifetime case, including another User's case. */
export const hasSupportRecoveryCaseForPairing = Effect.fn("Recovery.hasCaseForPairing")(function* (
  pairingId: BrowserLoginPairingId
) {
  const sql = yield* SqlClient.SqlClient;
  const { exists } = yield* SqlSchema.findOne({
    Request: BrowserLoginPairingId,
    Result: Schema.Struct({ exists: Schema.Boolean }),
    execute: (id) => sql`
        SELECT fidy_support_recovery_pairing_has_case(${id}) AS exists
      `,
  })(pairingId).pipe(Effect.orDie);
  return exists;
});

/** Serializes and checks global open-case admission through the minimum gateway authority. */
export const hasOpenCaseCapacity = Effect.fn("Recovery.hasOpenCaseCapacity")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const { available } = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ available: Schema.Boolean }),
    execute: () => sql`
      SELECT fidy_has_support_recovery_open_capacity() AS available
    `,
  })(undefined).pipe(Effect.orDie);
  return available;
});

type OperatorEvidence = Extract<
  SupportRecoveryCaseEvent,
  { readonly actor: { readonly _tag: "Operator" } }
>;
type OperatorEvent = Readonly<
  Omit<OperatorEvidence, "id" | "actor" | "occurredAt"> & {
    eventId: OperatorEvidence["id"];
    operatorId: OperatorEvidence["actor"]["operatorId"];
    occurredAt: DateTime.Utc;
  }
>;

/** Creates a case and its opening evidence inside the caller's transaction. */
export const insertSupportRecoveryCase = Effect.fn("Recovery.insertCase")(function* (input: {
  id: SupportRecoveryCaseId;
  eventId: SupportRecoveryCaseEventId;
  userId: UserId;
  pairingId: BrowserLoginPairingId;
  credentialRevision: number;
  operatorId: SupportOperatorId;
  openedAt: DateTime.Utc;
  expiresAt: DateTime.Utc;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO support_recovery_cases (
      id, user_id, pairing_id, credential_revision, lifecycle, opened_at, expires_at
    ) VALUES (
      ${input.id}, ${input.userId}, ${input.pairingId}, ${input.credentialRevision}, 'open',
      ${input.openedAt}, ${input.expiresAt}
    )
  `.pipe(Effect.orDie);
  yield* appendOperatorEvent({
    eventId: input.eventId,
    caseId: input.id,
    ordinal: 1,
    operatorId: input.operatorId,
    action: "open",
    outcome: "accepted",
    occurredAt: input.openedAt,
  });
  return {
    id: input.id,
    pairingId: input.pairingId,
    credentialRevision: input.credentialRevision,
    expiresAt: input.expiresAt,
    rejectionCount: 0,
    nextOrdinal: 2,
  } satisfies OpenSupportRecoveryCase;
});

/** Appends one operator-attributable event; the database seals legal action/outcome pairs. */
export const appendOperatorEvent = Effect.fn("Recovery.appendOperatorEvent")(function* (
  input: OperatorEvent
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO support_recovery_case_events (
      id, case_id, ordinal, operator_issuer, operator_subject, action, outcome, occurred_at
    ) VALUES (
      ${input.eventId}, ${input.caseId}, ${input.ordinal}, ${input.operatorId.issuer},
      ${input.operatorId.subject}, ${input.action}, ${input.outcome}, ${input.occurredAt}
    )
  `.pipe(Effect.orDie);
});

/** Appends policy expiry and closes the case atomically. */
export const expireSupportRecoveryCase = Effect.fn("Recovery.expireCase")(function* (input: {
  eventId: SupportRecoveryCaseEventId;
  recoveryCase: OpenSupportRecoveryCase;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO support_recovery_case_events (
      id, case_id, ordinal, policy_revision, action, outcome, occurred_at
    ) VALUES (
      ${input.eventId}, ${input.recoveryCase.id}, ${input.recoveryCase.nextOrdinal},
      'support-recovery-expiry-v1', 'expire', 'expired', ${input.recoveryCase.expiresAt}
    )
  `.pipe(Effect.orDie);
  yield* sql`
    UPDATE support_recovery_cases SET lifecycle = 'expired',
      closed_at = ${input.recoveryCase.expiresAt}
    WHERE id = ${input.recoveryCase.id} AND lifecycle = 'open'
  `.pipe(Effect.orDie);
});

/** Appends one generic rejection and terminally refuses the case on the fifth. */
export const rejectSupportRecoveryCase = Effect.fn("Recovery.rejectCase")(function* (input: {
  rejectionEventId: SupportRecoveryCaseEventId;
  refusalEventId: SupportRecoveryCaseEventId;
  recoveryCase: OpenSupportRecoveryCase;
  operatorId: SupportOperatorId;
  rejectedAt: DateTime.Utc;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* appendOperatorEvent({
    eventId: input.rejectionEventId,
    caseId: input.recoveryCase.id,
    ordinal: input.recoveryCase.nextOrdinal,
    operatorId: input.operatorId,
    action: "decide",
    outcome: "rejected",
    occurredAt: input.rejectedAt,
  });
  if (input.recoveryCase.rejectionCount < 4) return;
  yield* appendOperatorEvent({
    eventId: input.refusalEventId,
    caseId: input.recoveryCase.id,
    ordinal: input.recoveryCase.nextOrdinal + 1,
    operatorId: input.operatorId,
    action: "close",
    outcome: "refused",
    occurredAt: input.rejectedAt,
  });
  yield* sql`
    UPDATE support_recovery_cases SET lifecycle = 'refused', closed_at = ${input.rejectedAt}
    WHERE id = ${input.recoveryCase.id} AND lifecycle = 'open'
  `.pipe(Effect.orDie);
});

/** Consumes authority, appends accepted evidence, and closes the approved case. */
export const approveSupportRecoveryCase = Effect.fn("Recovery.approveCase")(function* (input: {
  eventId: SupportRecoveryCaseEventId;
  recoveryCase: OpenSupportRecoveryCase;
  userId: UserId;
  operatorId: SupportOperatorId;
  approvedAt: DateTime.Utc;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE backup_recovery_credentials SET code_digest = NULL, consumed_at = ${input.approvedAt},
      consumed_by_case_id = ${input.recoveryCase.id}
    WHERE user_id = ${input.userId} AND revision = ${input.recoveryCase.credentialRevision}
      AND code_digest IS NOT NULL AND consumed_at IS NULL
  `.pipe(Effect.orDie);
  yield* appendOperatorEvent({
    eventId: input.eventId,
    caseId: input.recoveryCase.id,
    ordinal: input.recoveryCase.nextOrdinal,
    operatorId: input.operatorId,
    action: "approve",
    outcome: "accepted",
    occurredAt: input.approvedAt,
  });
  yield* sql`
    UPDATE support_recovery_cases SET lifecycle = 'approved', closed_at = ${input.approvedAt}
    WHERE id = ${input.recoveryCase.id} AND lifecycle = 'open'
  `.pipe(Effect.orDie);
});

/** Installs one newly generated digest and removes all consumed-state metadata. */
export const rotateBackupRecoveryDigestInScope = Effect.fn("Recovery.rotateDigestInScope")(
  function* (input: {
    userId: UserId;
    webSessionId: WebSessionId;
    codeDigest: BackupRecoveryDigest;
    rotatedAt: DateTime.Utc;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      UPDATE backup_recovery_credentials SET code_digest = ${input.codeDigest},
        revision = revision + 1, created_at = ${input.rotatedAt}, consumed_at = NULL,
        consumed_by_case_id = NULL,
        last_rotated_by_web_session_id = ${input.webSessionId}
      WHERE user_id = ${input.userId}
        AND last_rotated_by_web_session_id IS DISTINCT FROM ${input.webSessionId}
        AND fidy_backup_recovery_rotation_allowed(${input.userId}, ${input.webSessionId})
      RETURNING user_id
    `.pipe(Effect.orDie);
    return rows.length === 1;
  }
);

/** Deletes one bounded batch of anonymous admission evidence after its one-hour window. */
export const purgeSupportRecoveryAdmissionEvidence = Effect.fn("Recovery.purgeAdmissionEvidence")(
  function* (observedAt: DateTime.Utc) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      DELETE FROM support_recovery_admission_attempts
      WHERE ctid IN (
        SELECT ctid FROM support_recovery_admission_attempts
        WHERE attempted_at <= ${observedAt}::timestamptz - interval '1 hour'
        ORDER BY attempted_at LIMIT 500
      )
    `.pipe(Effect.orDie);
  }
);

/** Transitions one fixed batch of pairing-expired open cases through policy evidence. */
export const expireDueSupportRecoveryCases = Effect.fn("Recovery.expireDueCases")(function* (
  observedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const { count } = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ count: Schema.BigIntFromString }),
    execute: () => sql`
        SELECT fidy_expire_support_recovery_cases(${observedAt}) AS count
      `,
  })(undefined).pipe(Effect.orDie);
  return count;
});

/** Deletes the transaction-scoped User's cases, events, and Recovery authority after verification. */
export const deleteSupportRecoveryForTitular = Effect.fn("Recovery.deleteForTitular")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`SELECT fidy_delete_support_recovery_for_titular()`.pipe(Effect.orDie);
});

/** Runs one fixed retention batch for terminal support evidence. */
export const deleteExpiredSupportRecoveryEvidence = Effect.fn("Recovery.deleteExpiredEvidence")(
  function* (observedAt: DateTime.Utc) {
    const sql = yield* SqlClient.SqlClient;
    const { count } = yield* SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ count: Schema.BigIntFromString }),
      execute: () => sql`
        SELECT fidy_delete_expired_support_recovery(${observedAt}) AS count
      `,
    })(undefined).pipe(Effect.orDie);
    return count;
  }
);
