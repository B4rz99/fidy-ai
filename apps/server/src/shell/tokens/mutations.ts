import { Crypto, DateTime, Duration, Effect, Encoding, Option, type Schema } from "effect";
import {
  type ConsentDecisionEvidence,
  ConsentRecord,
  ConsentRecordId,
  type ProviderQualifiedMessages,
} from "~/core/consent/model";
import type { UserId } from "~/core/identity/reference";
import {
  type CreateManualPATPayload,
  type ManualPATGrantInput,
  PAT,
  RevokedPAT,
  RevokedPATCount,
  type TokenBearer,
  TokenSecret,
  TokenShortId,
  bearerSecretBytes,
  makeTokenBearer,
} from "~/core/tokens/model";
import { PATId } from "~/core/tokens/reference";
import { computePATExpiration } from "~/core/tokens/rules";
import type { CanonicalCaller } from "~/shell/_shared/authz";
import type { CanonicalMutationImplementation } from "~/shell/_shared/canonical-mutation";
import { NotFound } from "~/shell/_shared/errors";
import type { OperationResponse } from "~/shell/_shared/response";
import { hashTokenBearer } from "~/shell/_shared/token-digest";
import {
  appendConsentRecordInScope,
  findPATGrantInScope,
  withSubjectLockInScope,
} from "~/shell/consent/repo";
import { currentManualPATDisclosure } from "./current-disclosure";
import {
  makePATIssuanceConsumed,
  makePATRateLimit,
  makePATReviewExpired,
  manualPATIssuanceLimit,
  manualPATIssuanceWindowMinutes,
  manualPATReviewWindowMinutes,
} from "./errors";
import {
  IssuedManualPATResponse,
  type ManualPATIssuanceConsumed,
  type ManualPATIssuanceRateLimited,
  type ManualPATReviewExpired,
} from "./operations";
import {
  getPATIssuanceAdmission,
  hasConsumedPATRequest,
  insertPATInScope,
  lockPATForRevocationInScope,
  lockRevocablePATsInScope,
  revokeApprovedPATPairingsInScope,
  revokeSelectedPATInScope,
} from "./repo";

const shortIdBytes = 4;
const reviewWindow = Duration.minutes(manualPATReviewWindowMinutes);
type MutationResponse<Data extends Schema.Top> = ReturnType<typeof OperationResponse<Data>>["Type"];

const manualPATResponse = (
  pat: PAT,
  bearer: TokenBearer
): MutationResponse<typeof IssuedManualPATResponse> => ({
  data: IssuedManualPATResponse.make({
    pat: { ...pat, idleExpiresAt: pat.expiresAt },
    bearer,
  }),
  next: [],
});

const resolveReviewedExpiration = Effect.fn("resolveReviewedExpiration")(function* (
  grant: ManualPATGrantInput,
  issuedAt: DateTime.Utc
) {
  const latestExpiration = yield* computePATExpiration({
    createdAt: issuedAt,
    lifetimeDays: grant.lifetimeDays,
  });
  if (grant.reviewExpiresAt === undefined) return yield* makePATReviewExpired();

  const earliestExpiration = DateTime.subtractDuration(latestExpiration, reviewWindow);
  const expirationMillis = DateTime.toEpochMillis(grant.reviewExpiresAt);
  if (
    expirationMillis <= DateTime.toEpochMillis(issuedAt) ||
    expirationMillis > DateTime.toEpochMillis(latestExpiration) ||
    expirationMillis < DateTime.toEpochMillis(earliestExpiration)
  ) {
    return yield* makePATReviewExpired();
  }
  return grant.reviewExpiresAt;
});

/** User and attributable caller facts required to create one reviewed manual PAT grant. */
export type CreateManualPATInput = Readonly<{
  userId: UserId;
  caller: CanonicalCaller;
  payload: CreateManualPATPayload;
}>;

/**
 * Creates one digest-only PAT and matching authenticated-web Consent grant inside the
 * caller-owned User transaction. The raw bearer exists only in the returned success value.
 */
const createManualPATInScope = Effect.fn("createManualPATInScope")(function* ({
  userId,
  caller,
  payload,
}: CreateManualPATInput) {
  if (caller.auditCaller._tag !== "WebSession") {
    return yield* Effect.die("PAT issuance dispatched without a WebSession");
  }
  const webSessionId = caller.auditCaller.webSessionId;
  const { requestId, grant } = payload;
  if (yield* hasConsumedPATRequest(userId, requestId)) {
    return yield* makePATIssuanceConsumed();
  }
  const crypto = yield* Crypto.Crypto;
  const createdAt = yield* DateTime.now;
  const admission = yield* getPATIssuanceAdmission(
    userId,
    createdAt,
    manualPATIssuanceWindowMinutes
  );
  if (admission.issuanceCount >= manualPATIssuanceLimit) {
    return yield* makePATRateLimit(admission.retryAfterSeconds);
  }
  const tokenId = PATId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
  const shortId = TokenShortId.make(
    Encoding.encodeHex(yield* crypto.randomBytes(shortIdBytes).pipe(Effect.orDie))
  );
  const secret = TokenSecret.make(
    Encoding.encodeBase64Url(yield* crypto.randomBytes(bearerSecretBytes).pipe(Effect.orDie))
  );
  const bearer = yield* makeTokenBearer({ shortId, secret });
  const tokenHash = yield* hashTokenBearer(bearer);
  const pat = PAT.make({
    _tag: "PAT",
    id: tokenId,
    shortId,
    recipientLabel: grant.recipientLabel,
    scopes: grant.scopes,
    lifetimeDays: grant.lifetimeDays,
    lastUsedAt: Option.none(),
    expiresAt: yield* resolveReviewedExpiration(grant, createdAt),
    revokedAt: Option.none(),
    createdAt,
  });
  const disclosure = yield* currentManualPATDisclosure(grant, pat.expiresAt).pipe(Effect.orDie);
  const consent = ConsentRecord.make({
    id: ConsentRecordId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
    subjectUserId: userId,
    event: { _tag: "Granted", grant: { _tag: "PAT", tokenId } },
    disclosure,
    occurredAt: createdAt,
    evidence: { _tag: "AuthenticatedWeb", webSessionId },
  });

  yield* insertPATInScope(userId, { ...pat, tokenHash, requestId });
  yield* appendConsentRecordInScope(consent);

  return manualPATResponse(pat, bearer);
});

/** Issues one manual PAT with matching Consent evidence or a typed admission failure. */
export const createManualPAT: CanonicalMutationImplementation<
  CreateManualPATInput,
  MutationResponse<typeof IssuedManualPATResponse>,
  ManualPATIssuanceConsumed | ManualPATIssuanceRateLimited | ManualPATReviewExpired,
  Crypto.Crypto
> = (input) => withSubjectLockInScope(input.userId, createManualPATInScope(input));

export type RevokePATInput = Readonly<{
  userId: UserId;
  caller: CanonicalCaller;
  confirmationEvidence: () => Option.Option<ProviderQualifiedMessages>;
  shortId: TokenShortId;
}>;

const patNotFound = (): NotFound =>
  NotFound.make({
    error: {
      code: "not_found",
      message: "No manageable PAT has that short id. Refresh the active PAT list before retrying.",
    },
    next: [],
  });

const revocationEvidence = Effect.fn("PAT.revocationEvidence")(function* (input: {
  readonly caller: CanonicalCaller;
  readonly confirmationEvidence: () => Option.Option<ProviderQualifiedMessages>;
}): Effect.fn.Return<ConsentDecisionEvidence> {
  if (input.caller.auditCaller._tag === "WebSession") {
    return { _tag: "AuthenticatedWeb", webSessionId: input.caller.auditCaller.webSessionId };
  }
  const evidence = input.confirmationEvidence();
  if (Option.isNone(evidence)) {
    return yield* Effect.die("Verified WhatsApp PAT revocation lacked provider evidence");
  }
  return evidence.value;
});

/** Revokes one claimed PAT and appends its symmetric Consent evidence exactly once. */
export const revokePAT: CanonicalMutationImplementation<
  RevokePATInput,
  MutationResponse<typeof RevokedPAT>,
  NotFound,
  Crypto.Crypto
> = Effect.fn("revokePAT")(function* ({ userId, caller, confirmationEvidence, shortId }) {
  return yield* withSubjectLockInScope(
    userId,
    Effect.gen(function* () {
      const candidate = yield* lockPATForRevocationInScope(userId, shortId);
      if (Option.isNone(candidate) || Option.isNone(candidate.value.tokenHash)) {
        return yield* patNotFound();
      }
      if (Option.isSome(candidate.value.revokedAt)) {
        return { data: RevokedPAT.make({ shortId }), next: [] };
      }
      const grant = yield* findPATGrantInScope(userId, candidate.value.id).pipe(
        Effect.flatMap(Effect.fromOption),
        Effect.orDie
      );
      const revokedAt = yield* DateTime.now;
      yield* revokeSelectedPATInScope(userId, candidate.value.id, revokedAt);
      const crypto = yield* Crypto.Crypto;
      yield* appendConsentRecordInScope(
        ConsentRecord.make({
          id: ConsentRecordId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
          subjectUserId: userId,
          event: { _tag: "Revoked", grantId: grant.id },
          disclosure: grant.disclosure,
          occurredAt: revokedAt,
          evidence: yield* revocationEvidence({ caller, confirmationEvidence }),
        })
      );
      return { data: RevokedPAT.make({ shortId }), next: [] };
    })
  );
});

export type RevokeAllPATsInput = Readonly<{
  userId: UserId;
  caller: CanonicalCaller;
  confirmationEvidence: () => Option.Option<ProviderQualifiedMessages>;
}>;

/** Revokes all active PATs and closes all approved unclaimed PAT authorization atomically. */
export const revokeAllPATs: CanonicalMutationImplementation<
  RevokeAllPATsInput,
  MutationResponse<typeof RevokedPATCount>,
  never,
  Crypto.Crypto
> = Effect.fn("revokeAllPATs")(function* ({ userId, caller, confirmationEvidence }) {
  return yield* withSubjectLockInScope(
    userId,
    Effect.gen(function* () {
      const revokedAt = yield* DateTime.now;
      const selected = yield* lockRevocablePATsInScope(userId, revokedAt);
      const crypto = yield* Crypto.Crypto;
      const evidence = yield* revocationEvidence({ caller, confirmationEvidence });
      for (const pat of selected) {
        const grant = yield* findPATGrantInScope(userId, pat.id).pipe(
          Effect.flatMap(Effect.fromOption),
          Effect.orDie
        );
        yield* revokeSelectedPATInScope(userId, pat.id, revokedAt);
        yield* appendConsentRecordInScope(
          ConsentRecord.make({
            id: ConsentRecordId.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie)),
            subjectUserId: userId,
            event: { _tag: "Revoked", grantId: grant.id },
            disclosure: grant.disclosure,
            occurredAt: revokedAt,
            evidence,
          })
        );
      }
      yield* revokeApprovedPATPairingsInScope(userId, revokedAt);
      return {
        data: RevokedPATCount.make({
          revokedCount: selected.filter(({ countedActive }) => countedActive).length,
        }),
        next: [],
      };
    })
  );
});
