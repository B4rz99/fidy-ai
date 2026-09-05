import { Data, type DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { PATPairingId, PATPairingLifecycle, PATPairingPublicCode } from "~/core/tokens/pairing";
import { PATLifetimeDays, PATRecipientLabel, PATScopes, TokenShortId } from "~/core/tokens/model";
import { PATId } from "~/core/tokens/reference";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { PATPairingReviewRateLimited, patPairingGenericMessage } from "./operations";

const maximumBurstStarts = 5;
const maximumStartsPerWindow = 10;
const maximumLivePairings = 10_000;
const maximumClaimBurst = 30;
const maximumClaimsPerWindow = 120;

const StartWrite = Schema.Struct({
  publicCode: PATPairingPublicCode,
  deviceCodeDigest: Schema.Uint8Array,
  sourceDigest: Schema.Uint8Array,
  recipientLabel: PATRecipientLabel,
  scopes: PATScopes,
  createdAt: Schema.DateTimeUtcFromDate,
  expiresAt: Schema.DateTimeUtcFromDate,
});
export type StartPATPairingWrite = typeof StartWrite.Type;

const StartAdmission = Schema.Struct({
  pairingId: Schema.OptionFromNullOr(PATPairingId),
  lockAcquired: Schema.Boolean,
  burstCount: Schema.Int,
  windowCount: Schema.Int,
  liveCount: Schema.Int,
  burstRetryAfterSeconds: Schema.Int,
  windowRetryAfterSeconds: Schema.Int,
});

/** Internal admission failure carrying a stable delay. */
export class PATPairingStartRateLimited extends Data.TaggedError("PATPairingStartRateLimited")<{
  readonly retryAfterSeconds: number;
}> {}
/** Internal fail-fast global/lock capacity failure. */
export class PATPairingCapacityExceeded extends Data.TaggedError("PATPairingCapacityExceeded") {}
export class PATPairingClaimSourceRateLimited extends Data.TaggedError(
  "PATPairingClaimSourceRateLimited"
)<{ readonly retryAfterSeconds: number }> {}

/** Inserts one admitted immutable request through the narrow pre-subject gateway. */
export const insertPendingPATPairing = Effect.fn("PATPairing.insertPending")(function* (
  input: StartPATPairingWrite
) {
  const sql = yield* SqlClient.SqlClient;
  const admission = yield* SqlSchema.findOne({
    Request: StartWrite,
    Result: StartAdmission,
    execute: (request) => sql`
      SELECT pairing_id AS "pairingId", lock_acquired AS "lockAcquired",
        burst_count AS "burstCount", window_count AS "windowCount",
        burst_retry_after_seconds AS "burstRetryAfterSeconds",
        window_retry_after_seconds AS "windowRetryAfterSeconds", live_count AS "liveCount"
      FROM fidy_insert_pending_pat_pairing(
        ${request.publicCode}, ${request.deviceCodeDigest}, ${request.recipientLabel},
        ${request.scopes}, ${request.sourceDigest}, ${request.createdAt}
      )
    `,
  })(input).pipe(Effect.orDie);
  if (!admission.lockAcquired || admission.liveCount >= maximumLivePairings) {
    return yield* new PATPairingCapacityExceeded();
  }
  if (admission.burstCount >= maximumBurstStarts) {
    return yield* new PATPairingStartRateLimited({
      retryAfterSeconds: Math.max(1, admission.burstRetryAfterSeconds),
    });
  }
  if (admission.windowCount >= maximumStartsPerWindow) {
    return yield* new PATPairingStartRateLimited({
      retryAfterSeconds: Math.max(1, admission.windowRetryAfterSeconds),
    });
  }
  return Option.map(admission.pairingId, (id) => ({ id }));
});

const LockedCandidateRow = Schema.Struct({
  pairingId: PATPairingId,
  userId: Schema.OptionFromNullOr(UserId),
  inspectedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  deviceCodeDigest: Schema.Uint8Array,
  lifecycle: PATPairingLifecycle,
  wrongProofAttempts: Schema.Int,
  minimumPollIntervalSeconds: Schema.Int,
  lastAcceptedPollAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  pairingExpiresAt: Schema.DateTimeUtcFromDate,
  tokenId: Schema.OptionFromNullOr(PATId),
  shortId: Schema.OptionFromNullOr(TokenShortId),
  recipientLabel: PATRecipientLabel,
  scopes: PATScopes,
  lifetimeDays: Schema.OptionFromNullOr(PATLifetimeDays),
  patExpiresAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  tokenCreatedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
});

type LockedPATPairingCandidateRow = typeof LockedCandidateRow.Type;
type ClaimablePATProjection = Readonly<{
  tokenId: PATId;
  shortId: TokenShortId;
  lifetimeDays: PATLifetimeDays;
  expiresAt: DateTime.Utc;
  createdAt: DateTime.Utc;
}>;
type LockedCandidateBase = Omit<
  LockedPATPairingCandidateRow,
  | "userId"
  | "inspectedAt"
  | "lifecycle"
  | "tokenId"
  | "shortId"
  | "lifetimeDays"
  | "patExpiresAt"
  | "tokenCreatedAt"
>;
export type ApprovedLockedPATPairingCandidate = LockedCandidateBase &
  Readonly<{
    _tag: "ApprovedAwaitingClaim";
    lifecycle: "approved_awaiting_claim";
    userId: UserId;
    authorization: ClaimablePATProjection;
  }>;
export type LockedPATPairingCandidate =
  | (LockedCandidateBase & Readonly<{ _tag: "PendingUninspected"; lifecycle: "pending_approval" }>)
  | (LockedCandidateBase &
      Readonly<{
        _tag: "PendingReviewed";
        lifecycle: "pending_approval";
        userId: UserId;
        inspectedAt: DateTime.Utc;
      }>)
  | ApprovedLockedPATPairingCandidate
  | (LockedCandidateBase & Readonly<{ _tag: "Claimed"; lifecycle: "claimed" }>)
  | (LockedCandidateBase & Readonly<{ _tag: "ExpiredUnapproved"; lifecycle: "expired_unapproved" }>)
  | (LockedCandidateBase & Readonly<{ _tag: "RevokedUnclaimed"; lifecycle: "revoked_unclaimed" }>);

const authorizationFromRow = Effect.fn(function* (row: LockedPATPairingCandidateRow) {
  const fields = [
    Option.isSome(row.tokenId),
    Option.isSome(row.shortId),
    Option.isSome(row.lifetimeDays),
    Option.isSome(row.patExpiresAt),
    Option.isSome(row.tokenCreatedAt),
  ];
  const present = fields.filter(Boolean).length;
  if (present !== 0 && present !== fields.length) {
    return yield* Effect.die("Paired PAT projection is partially present");
  }
  if (present === 0) return Option.none<ClaimablePATProjection>();
  return Option.some({
    tokenId: Option.getOrThrow(row.tokenId),
    shortId: Option.getOrThrow(row.shortId),
    lifetimeDays: Option.getOrThrow(row.lifetimeDays),
    expiresAt: Option.getOrThrow(row.patExpiresAt),
    createdAt: Option.getOrThrow(row.tokenCreatedAt),
  });
});

type ReviewBinding = Readonly<{ userId: UserId; inspectedAt: DateTime.Utc }>;

const reviewBindingFromRow = Effect.fn(function* (row: LockedPATPairingCandidateRow) {
  if (Option.isSome(row.userId) !== Option.isSome(row.inspectedAt)) {
    return yield* Effect.die("PATPairing review binding is partially present");
  }
  return Option.isSome(row.userId) && Option.isSome(row.inspectedAt)
    ? Option.some<ReviewBinding>({ userId: row.userId.value, inspectedAt: row.inspectedAt.value })
    : Option.none<ReviewBinding>();
});

const approvedCandidate = Effect.fn(function* (input: {
  readonly base: LockedCandidateBase;
  readonly binding: Option.Option<ReviewBinding>;
  readonly authorization: Option.Option<ClaimablePATProjection>;
}) {
  if (Option.isNone(input.binding) || Option.isNone(input.authorization)) {
    return yield* Effect.die("Approved PATPairing is missing its review or authorization");
  }
  return {
    ...input.base,
    _tag: "ApprovedAwaitingClaim" as const,
    lifecycle: "approved_awaiting_claim" as const,
    userId: input.binding.value.userId,
    authorization: input.authorization.value,
  };
});

const terminalCandidate = Effect.fn(function* (input: {
  readonly base: LockedCandidateBase;
  readonly lifecycle: "claimed" | "expired_unapproved" | "revoked_unclaimed";
  readonly binding: Option.Option<ReviewBinding>;
  readonly authorization: Option.Option<ClaimablePATProjection>;
}) {
  if (input.lifecycle === "expired_unapproved") {
    if (Option.isSome(input.authorization)) {
      return yield* Effect.die("Expired unapproved PATPairing has an authorization");
    }
    return { ...input.base, _tag: "ExpiredUnapproved" as const, lifecycle: input.lifecycle };
  }
  if (Option.isNone(input.binding) || Option.isNone(input.authorization)) {
    return yield* Effect.die("Authorized terminal PATPairing is missing its review or PAT");
  }
  return input.lifecycle === "claimed"
    ? { ...input.base, _tag: "Claimed" as const, lifecycle: input.lifecycle }
    : { ...input.base, _tag: "RevokedUnclaimed" as const, lifecycle: input.lifecycle };
});

const candidateFromRow = Effect.fn(function* (row: LockedPATPairingCandidateRow) {
  const authorization = yield* authorizationFromRow(row);
  const binding = yield* reviewBindingFromRow(row);
  const { lifecycle } = row;
  const base: LockedCandidateBase = {
    pairingId: row.pairingId,
    deviceCodeDigest: row.deviceCodeDigest,
    wrongProofAttempts: row.wrongProofAttempts,
    minimumPollIntervalSeconds: row.minimumPollIntervalSeconds,
    lastAcceptedPollAt: row.lastAcceptedPollAt,
    pairingExpiresAt: row.pairingExpiresAt,
    recipientLabel: row.recipientLabel,
    scopes: row.scopes,
  };
  switch (lifecycle) {
    case "pending_approval":
      if (Option.isSome(authorization)) {
        return yield* Effect.die("Pending PATPairing has an authorization");
      }
      return Option.match(binding, {
        onNone: () => ({ ...base, _tag: "PendingUninspected" as const, lifecycle }),
        onSome: ({ inspectedAt, userId }) => ({
          ...base,
          _tag: "PendingReviewed" as const,
          lifecycle,
          userId,
          inspectedAt,
        }),
      });
    case "approved_awaiting_claim":
      return yield* approvedCandidate({ base, binding, authorization });
    case "claimed":
    case "expired_unapproved":
    case "revoked_unclaimed":
      return yield* terminalCandidate({ base, lifecycle, binding, authorization });
  }
});

const ClaimAdmission = Schema.Struct({
  burstCount: Schema.Int,
  windowCount: Schema.Int,
  retryAfterSeconds: Schema.Int,
});

/** Persists and bounds anonymous claim traffic before looking up any pairing identity. */
export const admitPATPairingClaim = Effect.fn("PATPairing.admitClaim")(function* (input: {
  readonly sourceDigest: Uint8Array;
  readonly attemptedAt: DateTime.Utc;
}) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOne({
    Request: Schema.Struct({
      sourceDigest: Schema.Uint8Array,
      attemptedAt: Schema.DateTimeUtcFromDate,
    }),
    Result: ClaimAdmission,
    execute: (request) => sql`
      SELECT burst_count AS "burstCount", window_count AS "windowCount",
        retry_after_seconds AS "retryAfterSeconds"
      FROM fidy_admit_pat_pairing_claim(${request.sourceDigest}, ${request.attemptedAt})
    `,
  })(input).pipe(Effect.orDie);
  if (row.burstCount > maximumClaimBurst || row.windowCount > maximumClaimsPerWindow) {
    return yield* new PATPairingClaimSourceRateLimited({
      retryAfterSeconds: Math.max(1, row.retryAfterSeconds),
    });
  }
});

/** Fuses candidate locking, protected work, and transaction ownership. */
export const withLockedPATPairingCandidate = Effect.fn("PATPairing.withLockedCandidate")(function* <
  A,
  E,
  R,
>(
  pairingId: PATPairingId,
  use: (candidate: Option.Option<LockedPATPairingCandidate>) => Effect.Effect<A, E, R>
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const row = yield* SqlSchema.findOneOption({
        Request: PATPairingId,
        Result: LockedCandidateRow,
        execute: (id) => sql`
            SELECT pairing_id AS "pairingId", user_id AS "userId",
              inspected_at AS "inspectedAt",
              device_code_digest AS "deviceCodeDigest", lifecycle,
              wrong_proof_attempts AS "wrongProofAttempts",
              minimum_poll_interval_seconds AS "minimumPollIntervalSeconds",
              last_accepted_poll_at AS "lastAcceptedPollAt",
              pairing_expires_at AS "pairingExpiresAt", token_id AS "tokenId",
              short_id AS "shortId", recipient_label AS "recipientLabel", scopes,
              lifetime_days AS "lifetimeDays", pat_expires_at AS "patExpiresAt",
              token_created_at AS "tokenCreatedAt"
            FROM fidy_lock_pat_pairing(${id}::uuid)
          `,
      })(pairingId).pipe(Effect.orDie);
      const candidate = yield* Option.match(row, {
        onNone: () => Effect.succeed(Option.none<LockedPATPairingCandidate>()),
        onSome: (value) => candidateFromRow(value).pipe(Effect.asSome),
      });
      return yield* use(candidate);
    })
  );
});

const Changed = Schema.Struct({ changed: Schema.Boolean });

export const acceptPATPairingPoll = Effect.fn("PATPairing.acceptPoll")(function* (
  pairingId: PATPairingId,
  acceptedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    SELECT fidy_accept_pat_pairing_poll(${pairingId}::uuid, ${acceptedAt}) AS changed
  `.pipe(Effect.orDie, Effect.asVoid);
});
export const slowPATPairingPoll = Effect.fn("PATPairing.slowPoll")(function* (
  pairingId: PATPairingId,
  seconds: number
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    SELECT fidy_slow_pat_pairing_poll(${pairingId}::uuid, ${seconds}::integer) AS changed
  `.pipe(Effect.orDie, Effect.asVoid);
});
export const rejectPATPairingProof = Effect.fn("PATPairing.rejectProof")(function* (
  pairingId: PATPairingId,
  attempts: number
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    SELECT fidy_reject_pat_pairing_proof(${pairingId}::uuid, ${attempts}::integer) AS changed
  `.pipe(Effect.orDie, Effect.asVoid);
});
export const expireUnapprovedPATPairing = Effect.fn("PATPairing.expireUnapproved")(function* (
  pairingId: PATPairingId,
  expiredAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    SELECT fidy_expire_unapproved_pat_pairing(${pairingId}::uuid, ${expiredAt}) AS changed
  `.pipe(Effect.orDie, Effect.asVoid);
});
export const claimPATPairing = Effect.fn("PATPairing.claim")(function* (
  pairingId: PATPairingId,
  tokenHash: string,
  claimedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const result = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Changed,
    execute: () => sql`
      SELECT fidy_claim_pat_pairing(${pairingId}::uuid, ${tokenHash}, ${claimedAt}) AS changed
    `,
  })(undefined).pipe(Effect.orDie);
  return result.changed;
});

const ReviewRow = Schema.Struct({
  pairingId: PATPairingId,
  recipientLabel: PATRecipientLabel,
  scopes: PATScopes,
  claimBy: Schema.DateTimeUtcFromDate,
  inspectedAt: Schema.DateTimeUtcFromDate,
});

const bindPATPairingReview = Effect.fn(function* (input: {
  readonly userId: UserId;
  readonly publicCode: PATPairingPublicCode;
  readonly attemptedAt: DateTime.Utc;
}) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({
      userId: UserId,
      publicCode: PATPairingPublicCode,
      attemptedAt: Schema.DateTimeUtcFromDate,
    }),
    Result: ReviewRow,
    execute: (request) => sql`
      SELECT pairing_id AS "pairingId", recipient_label AS "recipientLabel", scopes,
        claim_by AS "claimBy", inspected_at AS "inspectedAt"
      FROM fidy_bind_pat_pairing_review(
        ${request.userId}, ${request.publicCode}, ${request.attemptedAt}
      )
    `,
  })(input).pipe(Effect.orDie);
});

const InspectionAdmission = Schema.Struct({
  admitted: Schema.Boolean,
  retryAfterSeconds: Schema.Int,
});

/** Durably reserves one serialized inspection attempt before canonical review work begins. */
export const reservePATPairingInspectionAttempt = Effect.fn("PATPairing.reserveInspection")(
  function* (input: { readonly userId: UserId; readonly attemptedAt: DateTime.Utc }) {
    const sql = yield* SqlClient.SqlClient;
    const admission = yield* withUserTransaction(
      input.userId,
      Effect.gen(function* () {
        // Acquire admission serialization before the counting statement takes its READ COMMITTED
        // snapshot, so concurrent requests observe attempts committed by the preceding holder.
        yield* sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended('pat-pairing-inspection:' || ${input.userId}::text, 249)
          )
        `;
        return yield* SqlSchema.findOne({
          Request: Schema.Void,
          Result: InspectionAdmission,
          execute: () => sql`
            SELECT admitted, retry_after_seconds AS "retryAfterSeconds"
            FROM fidy_reserve_pat_pairing_inspection(${input.userId}, ${input.attemptedAt})
          `,
        })(undefined);
      }).pipe(Effect.orDie)
    );
    if (!admission.admitted) {
      return yield* PATPairingReviewRateLimited.make({
        error: {
          code: "rate_limited",
          message: patPairingGenericMessage,
          retryAfterSeconds: Math.max(1, admission.retryAfterSeconds),
        },
        next: [],
      });
    }
  }
);

/** Finds and binds one admitted live public-code request to the inspecting User. */
export const inspectPATPairingInScope = bindPATPairingReview;

const ApprovalRow = Schema.Struct({
  pairingId: PATPairingId,
  recipientLabel: PATRecipientLabel,
  scopes: PATScopes,
  claimBy: Schema.DateTimeUtcFromDate,
  inspectedAt: Schema.DateTimeUtcFromDate,
});

/** Locks the exact User-bound request for approval in the canonical transaction. */
export const lockPATPairingApprovalInScope = Effect.fn("PATPairing.lockApprovalInScope")(function* (
  userId: UserId,
  pairingId: PATPairingId,
  attemptedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({
      userId: UserId,
      pairingId: PATPairingId,
      attemptedAt: Schema.DateTimeUtcFromDate,
    }),
    Result: ApprovalRow,
    execute: (request) => sql`
        SELECT pairing_id AS "pairingId", recipient_label AS "recipientLabel", scopes,
          claim_by AS "claimBy", inspected_at AS "inspectedAt"
        FROM fidy_lock_pat_pairing_approval(
          ${request.userId}, ${request.pairingId}, ${request.attemptedAt}
        )
      `,
  })({ userId, pairingId, attemptedAt }).pipe(Effect.orDie);
});

/** Transitions the request only after its PAT and grant Consent exist in the same transaction. */
export const markPATPairingApprovedInScope = Effect.fn("PATPairing.markApprovedInScope")(function* (
  userId: UserId,
  pairingId: PATPairingId,
  approvedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    SELECT fidy_mark_pat_pairing_approved(${userId}, ${pairingId}, ${approvedAt})
  `.pipe(Effect.orDie);
});

/** Purges anonymous source digests through their narrow retention gateway. */
export const purgeExpiredPATPairingEvidence = Effect.fn("PATPairing.purgeAttemptEvidence")(
  function* (attemptedAt: DateTime.Utc) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      SELECT fidy_purge_pat_pairing_attempt_evidence(${attemptedAt})
    `.pipe(Effect.orDie, Effect.asVoid);
  }
);

/** Bulk-transitions due unapproved requests; no User or Consent exists for them. */
export const expireDueUnapprovedPATPairings = Effect.fn("PATPairing.expireDueUnapproved")(
  function* (attemptedAt: DateTime.Utc) {
    const sql = yield* SqlClient.SqlClient;
    const row = yield* SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ expired: Schema.Int }),
      execute: () => sql`
        SELECT fidy_expire_unapproved_pat_pairings(${attemptedAt}) AS expired
      `,
    })(undefined).pipe(Effect.orDie);
    return row.expired;
  }
);

/** Deletes terminal request metadata after its bounded security-retention window. */
export const purgeRetainedTerminalPATPairings = Effect.fn("PATPairing.purgeTerminal")(function* (
  retentionBefore: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ removed: Schema.Int }),
    execute: () => sql`
        SELECT fidy_purge_terminal_pat_pairings(${retentionBefore}) AS removed
      `,
  })(undefined).pipe(Effect.orDie);
  return row.removed;
});

export const listDueApprovedPATPairings = Effect.fn("PATPairing.listDueApproved")(function* (
  attemptedAt: DateTime.Utc,
  limit: number
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ pairingId: PATPairingId, userId: UserId }),
    execute: () => sql`
      SELECT pairing_id AS "pairingId", subject_user_id AS "userId"
      FROM fidy_due_approved_pat_pairings(${attemptedAt}, ${limit}::integer)
    `,
  })(undefined).pipe(Effect.orDie);
});

const DueApproval = Schema.Struct({
  pairingId: PATPairingId,
  tokenId: PATId,
});

/** Locks one due approved request through ordinary User-scoped RLS. */
export const lockDueApprovedPATPairingInScope = Effect.fn("PATPairing.lockDueApprovedInScope")(
  function* (userId: UserId, pairingId: PATPairingId, attemptedAt: DateTime.Utc) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: Schema.Struct({
        userId: UserId,
        pairingId: PATPairingId,
        attemptedAt: Schema.DateTimeUtcFromDate,
      }),
      Result: DueApproval,
      execute: (request) => sql`
        SELECT pairing_id AS "pairingId", token_id AS "tokenId"
        FROM fidy_lock_due_approved_pat_pairing(
          ${request.userId}, ${request.pairingId}, ${request.attemptedAt}
        )
      `,
    })({ userId, pairingId, attemptedAt }).pipe(Effect.orDie);
  }
);

/** Marks the User-scoped approved request revoked after its PAT/Consent transition. */
export const markPATPairingRevokedInScope = Effect.fn("PATPairing.markRevokedInScope")(function* (
  userId: UserId,
  pairingId: PATPairingId,
  revokedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    SELECT fidy_revoke_unclaimed_pat_pairing(${userId}, ${pairingId}, ${revokedAt})
  `.pipe(Effect.orDie);
});
