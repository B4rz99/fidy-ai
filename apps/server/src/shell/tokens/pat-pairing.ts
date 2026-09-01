import { TaggedSerializableError } from "~/schema-compatibility";
import { timingSafeEqual } from "node:crypto";
import {
  Crypto,
  DateTime,
  Duration,
  Effect,
  Encoding,
  Option,
  Predicate,
  Redacted,
  Schema,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { normalizeOpaqueProof32 } from "~/core/_shared/opaque-proof";
import { ConsentRecord, ConsentRecordId } from "~/core/consent/model";
import type { UserId } from "~/core/identity/reference";
import {
  type IssuedPAT,
  PAT,
  type PATRecipientLabel,
  type PATScopes,
  TokenSecret,
  TokenShortId,
  bearerSecretBytes,
  defaultPATLifetimeDays,
  makeTokenBearer,
} from "~/core/tokens/model";
import {
  type ApprovePATPairingPayload,
  ApprovedPATPairing,
  type PATPairingClaimDecision,
  PATPairingDeviceCode,
  PATPairingId,
  PATPairingPublicCode,
  PATPairingPublicCodeInput,
  PATPairingReview,
  type PendingPATPairingClaim,
  type StartPATPairingPayload,
  type StartedPATPairing,
  decidePATPairingClaim,
  patPairingExpiry,
  patPairingPollingIntervalSeconds,
  selectPATPairingPublicCodeSymbols,
} from "~/core/tokens/pairing";
import { PATId } from "~/core/tokens/reference";
import { computePATExpiration } from "~/core/tokens/rules";
import type { WebSessionId } from "~/core/web-session/reference";
import type { ClaimPATPairingPayload } from "~/pat-pairing-api";
import type { CanonicalCaller } from "~/shell/_shared/authz";
import type { CanonicalMutationImplementation } from "~/shell/_shared/canonical-mutation";
import {
  CanonicalPreTransactions,
  takeCanonicalPreTransactionState,
  withCanonicalPreTransaction,
} from "~/shell/_shared/canonical-pre-transaction";
import type { OperationResponse } from "~/shell/_shared/response";
import { hashTokenBearer } from "~/shell/_shared/token-digest";
import {
  appendConsentRecordInScope,
  findPATGrantInScope,
  withSubjectLockInScope,
} from "~/shell/consent/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { currentPairedPATDisclosure } from "./current-disclosure";
import { makePATRateLimit, manualPATIssuanceLimit, manualPATIssuanceWindowMinutes } from "./errors";
import {
  type ManualPATIssuanceRateLimited,
  PATPairingReviewRateLimited,
  PATPairingReviewRejected,
  patPairingGenericMessage,
  patPairingInspectOperation,
} from "./operations";
import {
  type ApprovedLockedPATPairingCandidate,
  type LockedPATPairingCandidate,
  type PATPairingCapacityExceeded,
  type PATPairingStartRateLimited,
  acceptPATPairingPoll,
  admitPATPairingClaim,
  expireDueUnapprovedPATPairings,
  expireUnapprovedPATPairing,
  insertPendingPATPairing,
  inspectPATPairingInScope,
  listDueApprovedPATPairings,
  lockDueApprovedPATPairingInScope,
  lockPATPairingApprovalInScope,
  markPATPairingApprovedInScope,
  markPATPairingRevokedInScope,
  claimPATPairing as persistPATPairingClaim,
  purgeExpiredPATPairingEvidence,
  purgeRetainedTerminalPATPairings,
  rejectPATPairingProof,
  reservePATPairingInspectionAttempt,
  slowPATPairingPoll,
  withLockedPATPairingCandidate,
} from "./pat-pairing-persistence";
import {
  getPATIssuanceAdmission,
  insertAwaitingClaimPATInScope,
  revokePairedPATInScope,
} from "./repo";

export class PATPairingInvalid extends TaggedSerializableError<PATPairingInvalid>()(
  "PATPairingInvalid",
  {}
) {}
export class PATPairingPollingRateLimited extends TaggedSerializableError<PATPairingPollingRateLimited>()(
  "PATPairingPollingRateLimited",
  { retryAfterSeconds: Schema.Int }
) {}

const proofOctets = 32;
const publicCodeSymbols = 8;
const randomCodeBatchOctets = 16;
const dummyPairingId = PATPairingId.make("00000000-0000-4000-8000-000000000000");
const stringOrEmpty = (value: unknown): string => (Predicate.isString(value) ? value : "");
const sha256 = (bytes: Uint8Array): Effect.Effect<Uint8Array, never, Crypto.Crypto> =>
  Effect.flatMap(Crypto.Crypto, (crypto) => crypto.digest("SHA-256", bytes)).pipe(Effect.orDie);

const generatePublicCode = Effect.fn(function* () {
  const crypto = yield* Crypto.Crypto;
  let symbols = "";
  while (symbols.length < publicCodeSymbols) {
    const bytes = yield* crypto.randomBytes(randomCodeBatchOctets).pipe(Effect.orDie);
    symbols += selectPATPairingPublicCodeSymbols({
      bytes: Array.from(bytes),
      maximum: publicCodeSymbols - symbols.length,
    });
  }
  return PATPairingPublicCode.make(`${symbols.slice(0, 4)}-${symbols.slice(4)}`);
});

const insertWithUniqueCode = (
  input: Omit<Parameters<typeof insertPendingPATPairing>[0], "publicCode">
): Effect.Effect<
  Readonly<{ pairingId: PATPairingId; publicCode: PATPairingPublicCode }>,
  PATPairingStartRateLimited | PATPairingCapacityExceeded,
  Crypto.Crypto | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const publicCode = yield* generatePublicCode();
    const inserted = yield* insertPendingPATPairing({ ...input, publicCode });
    return yield* Option.match(inserted, {
      onNone: () => insertWithUniqueCode(input),
      onSome: ({ id }) => Effect.succeed({ pairingId: id, publicCode }),
    });
  });

/** Starts one immutable request while persisting only digests of both private proof and source. */
export const startPATPairing = Effect.fn("PATPairing.start")(function* (
  payload: StartPATPairingPayload,
  sourceAddress: string
): Effect.fn.Return<
  StartedPATPairing,
  PATPairingStartRateLimited | PATPairingCapacityExceeded,
  Crypto.Crypto | SqlClient.SqlClient
> {
  const crypto = yield* Crypto.Crypto;
  const createdAt = yield* DateTime.now;
  const expiresAt = patPairingExpiry(createdAt);
  const proofBytes = yield* crypto.randomBytes(proofOctets).pipe(Effect.orDie);
  const privateDeviceCode = PATPairingDeviceCode.make(Encoding.encodeBase64Url(proofBytes));
  const redactedDeviceCode = Redacted.make(privateDeviceCode);
  const deviceCodeDigest = yield* sha256(
    new TextEncoder().encode(Redacted.value(redactedDeviceCode))
  );
  const sourceDigest = yield* sha256(new TextEncoder().encode(sourceAddress));
  const { pairingId, publicCode } = yield* insertWithUniqueCode({
    deviceCodeDigest,
    sourceDigest,
    recipientLabel: payload.recipientLabel,
    scopes: payload.scopes,
    createdAt,
    expiresAt,
  });
  return {
    pairingId,
    privateDeviceCode: redactedDeviceCode,
    publicCode,
    expiresAt,
    pollingIntervalSeconds: patPairingPollingIntervalSeconds,
  };
});

type ClaimSuccess = PendingPATPairingClaim | IssuedPAT;
type ClaimOutcome =
  | Readonly<{ _tag: "Invalid" }>
  | Readonly<{ _tag: "DueApproved"; userId: UserId; pairingId: PATPairingId }>
  | Readonly<{ _tag: "RateLimited"; retryAfterSeconds: number }>
  | Readonly<{ _tag: "Success"; value: ClaimSuccess }>;

const completeClaim = Effect.fn("PATPairing.completeClaim")(function* (
  candidate: ApprovedLockedPATPairingCandidate,
  attemptedAt: DateTime.Utc
): Effect.fn.Return<ClaimOutcome, never, Crypto.Crypto | SqlClient.SqlClient> {
  const authorization = candidate.authorization;
  const crypto = yield* Crypto.Crypto;
  const secret = TokenSecret.make(
    Encoding.encodeBase64Url(yield* crypto.randomBytes(bearerSecretBytes).pipe(Effect.orDie))
  );
  const bearer = yield* makeTokenBearer({ shortId: authorization.shortId, secret });
  const digest = yield* hashTokenBearer(bearer);
  const changed = yield* persistPATPairingClaim(candidate.pairingId, digest, attemptedAt);
  if (!changed) return { _tag: "Invalid" };
  return {
    _tag: "Success",
    value: {
      pat: PAT.make({
        _tag: "PAT",
        id: authorization.tokenId,
        shortId: authorization.shortId,
        recipientLabel: candidate.recipientLabel,
        scopes: candidate.scopes,
        lifetimeDays: authorization.lifetimeDays,
        lastUsedAt: Option.none(),
        expiresAt: authorization.expiresAt,
        revokedAt: Option.none(),
        createdAt: authorization.createdAt,
      }),
      bearer,
    },
  };
});

const dueApprovedOutcome = (candidate: LockedPATPairingCandidate): ClaimOutcome =>
  candidate._tag === "ApprovedAwaitingClaim"
    ? {
        _tag: "DueApproved",
        userId: candidate.userId,
        pairingId: candidate.pairingId,
      }
    : { _tag: "Invalid" };

const completeApprovedClaim = (
  candidate: LockedPATPairingCandidate,
  attemptedAt: DateTime.Utc
): Effect.Effect<ClaimOutcome, never, Crypto.Crypto | SqlClient.SqlClient> =>
  candidate._tag === "ApprovedAwaitingClaim"
    ? completeClaim(candidate, attemptedAt)
    : Effect.succeed({ _tag: "Invalid" });

const applyClaimDecision = Effect.fn("PATPairing.applyClaimDecision")(function* (input: {
  readonly candidate: LockedPATPairingCandidate;
  readonly decision: PATPairingClaimDecision;
  readonly attemptedAt: DateTime.Utc;
}): Effect.fn.Return<ClaimOutcome, never, Crypto.Crypto | SqlClient.SqlClient> {
  const { candidate, decision } = input;
  switch (decision._tag) {
    case "Invalid":
      return { _tag: "Invalid" };
    case "RevokeUnclaimed":
      return dueApprovedOutcome(candidate);
    case "ExpireUnapproved":
      yield* expireUnapprovedPATPairing(candidate.pairingId, input.attemptedAt);
      return { _tag: "Invalid" };
    case "WrongProof":
      yield* rejectPATPairingProof(candidate.pairingId, decision.wrongProofAttempts);
      return { _tag: "Invalid" };
    case "SlowDown":
      yield* slowPATPairingPoll(candidate.pairingId, decision.minimumPollIntervalSeconds);
      return { _tag: "RateLimited", retryAfterSeconds: decision.retryAfterSeconds };
    case "Pending":
      yield* acceptPATPairingPoll(candidate.pairingId, decision.acceptedAt);
      return {
        _tag: "Success",
        value: {
          status: "pending_approval",
          expiresAt: candidate.pairingExpiresAt,
          pollingIntervalSeconds: decision.minimumPollIntervalSeconds,
        },
      };
    case "Claim":
      return yield* completeApprovedClaim(candidate, input.attemptedAt);
  }
});

const claimLocked = Effect.fn("PATPairing.claimLocked")(function* (input: {
  candidate: Option.Option<LockedPATPairingCandidate>;
  parsedPairingId: Option.Option<PATPairingId>;
  attemptedDigest: Uint8Array;
  attemptedAt: DateTime.Utc;
}): Effect.fn.Return<ClaimOutcome, never, Crypto.Crypto | SqlClient.SqlClient> {
  const candidate = input.candidate;
  const expectedDigest = Option.match(candidate, {
    onNone: () => new Uint8Array(proofOctets),
    onSome: (value) => value.deviceCodeDigest,
  });
  const proofMatches = timingSafeEqual(input.attemptedDigest, expectedDigest);
  if (Option.isNone(candidate) || Option.isNone(input.parsedPairingId)) {
    yield* rejectPATPairingProof(dummyPairingId, 0);
    return { _tag: "Invalid" };
  }
  const decision = yield* decidePATPairingClaim({
    lifecycle: candidate.value.lifecycle,
    proofMatches,
    wrongProofAttempts: candidate.value.wrongProofAttempts,
    minimumPollIntervalSeconds: candidate.value.minimumPollIntervalSeconds,
    lastAcceptedPollAt: candidate.value.lastAcceptedPollAt,
    expiresAt: candidate.value.pairingExpiresAt,
    attemptedAt: input.attemptedAt,
  });
  return yield* applyClaimDecision({
    candidate: candidate.value,
    decision,
    attemptedAt: input.attemptedAt,
  });
});

/** Polls or claims under one row lock after one bounded hash and timing-safe comparison. */
export const claimPATPairing = Effect.fn("PATPairing.claim")(function* (
  payload: ClaimPATPairingPayload,
  sourceAddress: string
) {
  const sql = yield* SqlClient.SqlClient;
  const attemptedAt = yield* DateTime.now;
  const parsedPairingId = Schema.decodeUnknownOption(PATPairingId)(payload.pairingId);
  const pairingId = Option.getOrElse(parsedPairingId, () => dummyPairingId);
  const attemptedDigest = yield* sha256(
    new TextEncoder().encode(normalizeOpaqueProof32(stringOrEmpty(payload.privateDeviceCode)))
  );
  const sourceDigest = yield* sha256(new TextEncoder().encode(sourceAddress));
  const outcome = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* admitPATPairingClaim({ sourceDigest, attemptedAt });
        return yield* withLockedPATPairingCandidate(pairingId, (candidate) =>
          claimLocked({ candidate, parsedPairingId, attemptedDigest, attemptedAt })
        );
      })
    )
    .pipe(Effect.catchTag("SqlError", Effect.die));
  switch (outcome._tag) {
    case "Invalid":
      return yield* PATPairingInvalid.make();
    case "DueApproved":
      yield* expireOneApprovedPATPairing(outcome.userId, outcome.pairingId, attemptedAt);
      return yield* PATPairingInvalid.make();
    case "RateLimited":
      return yield* PATPairingPollingRateLimited.make({
        retryAfterSeconds: outcome.retryAfterSeconds,
      });
    case "Success":
      return outcome.value;
  }
});

const pairedPATShortIdBytes = 4;
const terminalRetentionHours = 24;
const expiryBatchSize = 25;
const terminalRetention = Duration.hours(terminalRetentionHours);
type PATPairingMutationResponse<Data extends Schema.Top> = ReturnType<
  typeof OperationResponse<Data>
>["Type"];

const rejectPATPairingReview = (): PATPairingReviewRejected =>
  PATPairingReviewRejected.make({
    error: { code: "validation_failed", message: patPairingGenericMessage },
    next: [],
  });

const PATPairingInspectionAdmission = Schema.TaggedStruct("PATPairingInspectionAdmission", {
  retryAfterSeconds: Schema.NullOr(Schema.Int),
});

type PATPairingInspectionAdmission = typeof PATPairingInspectionAdmission.Type;
type InspectPATPairingInput = Readonly<{ userId: UserId; publicCode: string }>;
type InspectPATPairingFailure = PATPairingReviewRateLimited | PATPairingReviewRejected;

const reservePATPairingInspection = (
  userId: UserId
): Effect.Effect<void, PATPairingReviewRateLimited, SqlClient.SqlClient> =>
  DateTime.now.pipe(
    Effect.flatMap((attemptedAt) => reservePATPairingInspectionAttempt({ userId, attemptedAt }))
  );

const preparePATPairingInspection = (
  userId: UserId
): Effect.Effect<ReadonlyArray<Schema.Json>, never, SqlClient.SqlClient> =>
  reservePATPairingInspection(userId).pipe(
    Effect.as([
      {
        _tag: "PATPairingInspectionAdmission",
        retryAfterSeconds: null,
      } satisfies PATPairingInspectionAdmission,
    ]),
    Effect.catchTag("PATPairingReviewRateLimited", (failure) =>
      Effect.succeed([
        {
          _tag: "PATPairingInspectionAdmission",
          retryAfterSeconds: failure.error.retryAfterSeconds,
        } satisfies PATPairingInspectionAdmission,
      ])
    )
  );

// HttpApi may wrap a handler Effect before authorization executes it. The operation fallback keeps
// inspection admission durable even when that adapter cannot preserve the original Effect identity.
CanonicalPreTransactions.registerFallback(patPairingInspectOperation, (caller) =>
  preparePATPairingInspection(caller.subjectUserId)
);

/** Binds one durably admitted live request and returns its immutable safe review. */
export const inspectPATPairing = (
  input: InspectPATPairingInput
): Effect.Effect<
  PATPairingMutationResponse<typeof PATPairingReview>,
  InspectPATPairingFailure,
  SqlClient.SqlClient
> => {
  const inspect = Effect.gen(function* () {
    const prepared = yield* takeCanonicalPreTransactionState;
    if (Option.isNone(prepared)) {
      yield* reservePATPairingInspection(input.userId);
    } else {
      const admission = yield* Schema.decodeUnknownEffect(PATPairingInspectionAdmission)(
        prepared.value
      ).pipe(Effect.orDie);
      if (admission.retryAfterSeconds !== null) {
        return yield* PATPairingReviewRateLimited.make({
          error: {
            code: "rate_limited",
            message: patPairingGenericMessage,
            retryAfterSeconds: admission.retryAfterSeconds,
          },
          next: [],
        });
      }
    }
    const inspectedAt = yield* DateTime.now;
    const code = Schema.decodeOption(PATPairingPublicCodeInput)(input.publicCode);
    if (Option.isNone(code)) return yield* rejectPATPairingReview();
    const review = yield* inspectPATPairingInScope({
      userId: input.userId,
      publicCode: code.value,
      attemptedAt: inspectedAt,
    });
    if (Option.isNone(review)) return yield* rejectPATPairingReview();
    const patExpiresAt = yield* computePATExpiration({
      createdAt: review.value.inspectedAt,
      lifetimeDays: defaultPATLifetimeDays,
    });
    return {
      data: PATPairingReview.make({
        ...review.value,
        lifetimeDays: defaultPATLifetimeDays,
        patExpiresAt,
      }),
      next: [],
    };
  });
  return withCanonicalPreTransaction(
    inspect.pipe(Effect.withSpan("PATPairing.inspect")),
    preparePATPairingInspection(input.userId)
  );
};

export type ApprovePATPairingInput = Readonly<{
  userId: UserId;
  caller: CanonicalCaller;
  payload: ApprovePATPairingPayload;
}>;

const persistPairedPATAuthorization = Effect.fn("PATPairing.persistAuthorization")(
  function* (input: {
    readonly userId: UserId;
    readonly webSessionId: WebSessionId;
    readonly payload: ApprovePATPairingPayload;
    readonly candidate: Readonly<{
      recipientLabel: PATRecipientLabel;
      scopes: PATScopes;
      claimBy: DateTime.Utc;
    }>;
    readonly approvedAt: DateTime.Utc;
  }) {
    const crypto = yield* Crypto.Crypto;
    const tokenId = PATId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
    const shortId = TokenShortId.make(
      Encoding.encodeHex(yield* crypto.randomBytes(pairedPATShortIdBytes).pipe(Effect.orDie))
    );
    const pat = PAT.make({
      _tag: "PAT",
      id: tokenId,
      shortId,
      recipientLabel: input.candidate.recipientLabel,
      scopes: input.candidate.scopes,
      lifetimeDays: defaultPATLifetimeDays,
      lastUsedAt: Option.none(),
      expiresAt: input.payload.patExpiresAt,
      revokedAt: Option.none(),
      createdAt: input.approvedAt,
    });
    const disclosure = yield* currentPairedPATDisclosure(
      {
        recipientLabel: pat.recipientLabel,
        scopes: pat.scopes,
        lifetimeDays: pat.lifetimeDays,
        reviewExpiresAt: input.payload.patExpiresAt,
      },
      pat.expiresAt
    ).pipe(Effect.orDie);
    yield* insertAwaitingClaimPATInScope(input.userId, {
      ...pat,
      pairingId: input.payload.pairingId,
    });
    yield* appendConsentRecordInScope(
      ConsentRecord.make({
        id: ConsentRecordId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
        subjectUserId: input.userId,
        event: { _tag: "Granted", grant: { _tag: "PAT", tokenId } },
        disclosure,
        occurredAt: input.approvedAt,
        evidence: { _tag: "AuthenticatedWeb", webSessionId: input.webSessionId },
      })
    );
    yield* markPATPairingApprovedInScope(input.userId, input.payload.pairingId, input.approvedAt);
  }
);

const approvePATPairingInScope = Effect.fn("PATPairing.approveInScope")(function* ({
  userId,
  caller,
  payload,
}: ApprovePATPairingInput) {
  if (caller.auditCaller._tag !== "WebSession") {
    return yield* Effect.die("PAT pairing approval dispatched without a WebSession");
  }
  const approvedAt = yield* DateTime.now;
  const admission = yield* getPATIssuanceAdmission(
    userId,
    approvedAt,
    manualPATIssuanceWindowMinutes
  );
  if (admission.issuanceCount >= manualPATIssuanceLimit) {
    return yield* makePATRateLimit(admission.retryAfterSeconds);
  }
  const candidate = yield* lockPATPairingApprovalInScope(userId, payload.pairingId, approvedAt);
  if (Option.isNone(candidate)) return yield* rejectPATPairingReview();
  const reviewedExpiration = yield* computePATExpiration({
    createdAt: candidate.value.inspectedAt,
    lifetimeDays: defaultPATLifetimeDays,
  });
  if (
    DateTime.toEpochMillis(payload.patExpiresAt) !== DateTime.toEpochMillis(reviewedExpiration) ||
    DateTime.isLessThanOrEqualTo(payload.patExpiresAt, approvedAt)
  ) {
    return yield* rejectPATPairingReview();
  }
  yield* persistPairedPATAuthorization({
    userId,
    webSessionId: caller.auditCaller.webSessionId,
    payload,
    candidate: candidate.value,
    approvedAt,
  });
  return {
    data: ApprovedPATPairing.make({
      pairingId: payload.pairingId,
      claimBy: candidate.value.claimBy,
    }),
    next: [],
  };
});

/** Creates one awaiting-claim PAT and its grant Consent in the canonical User transaction. */
export const approvePATPairing: CanonicalMutationImplementation<
  ApprovePATPairingInput,
  PATPairingMutationResponse<typeof ApprovedPATPairing>,
  PATPairingReviewRejected | ManualPATIssuanceRateLimited,
  Crypto.Crypto
> = (input) => withSubjectLockInScope(input.userId, approvePATPairingInScope(input));

const expireOneApprovedPATPairing = Effect.fn("PATPairing.expireOneApproved")(function* (
  userId: UserId,
  pairingId: PATPairingId,
  attemptedAt: DateTime.Utc
) {
  return yield* withUserTransaction(
    userId,
    withSubjectLockInScope(
      userId,
      Effect.gen(function* () {
        const candidate = yield* lockDueApprovedPATPairingInScope(userId, pairingId, attemptedAt);
        if (Option.isNone(candidate)) return false;
        const grant = yield* findPATGrantInScope(userId, candidate.value.tokenId);
        if (Option.isNone(grant)) {
          return yield* Effect.die("Approved paired PAT is missing its grant Consent");
        }
        const changed = yield* revokePairedPATInScope(userId, candidate.value.tokenId, attemptedAt);
        if (!changed) return false;
        const crypto = yield* Crypto.Crypto;
        yield* appendConsentRecordInScope(
          ConsentRecord.make({
            id: ConsentRecordId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
            subjectUserId: userId,
            event: { _tag: "Revoked", grantId: grant.value.id },
            disclosure: grant.value.disclosure,
            occurredAt: attemptedAt,
            evidence: {
              _tag: "AutomaticPolicy",
              policy: "pat-approved-unclaimed-expiry",
            },
          })
        );
        yield* markPATPairingRevokedInScope(userId, pairingId, attemptedAt);
        return true;
      })
    )
  );
});

/** Processes one bounded due batch through the same lifecycle authority as claim. */
export const expireDuePATPairings = Effect.fn("PATPairing.expireDue")(function* () {
  const attemptedAt = yield* DateTime.now;
  yield* purgeExpiredPATPairingEvidence(attemptedAt);
  yield* expireDueUnapprovedPATPairings(attemptedAt);
  yield* purgeRetainedTerminalPATPairings(
    DateTime.subtractDuration(attemptedAt, terminalRetention)
  );
  const due = yield* listDueApprovedPATPairings(attemptedAt, expiryBatchSize);
  return yield* Effect.forEach(
    due,
    ({ userId, pairingId }) => expireOneApprovedPATPairing(userId, pairingId, attemptedAt),
    { concurrency: 1 }
  );
});
