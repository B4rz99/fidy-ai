import { Crypto, DateTime, Effect, Encoding, Option } from "effect";
import type { Schema } from "effect";
import { ConsentRecord, ConsentRecordId } from "~/core/consent/model";
import type { UserId } from "~/core/identity/reference";
import {
  type CreateManualPATPayload,
  IssuedManualPAT,
  PAT,
  TokenSecret,
  TokenShortId,
  bearerSecretBytes,
  makeTokenBearer,
} from "~/core/tokens/model";
import { PATId } from "~/core/tokens/reference";
import { computePatIdleExpiry } from "~/core/tokens/rules";
import type { CanonicalCaller } from "~/shell/_shared/authz";
import type { CanonicalMutationImplementation } from "~/shell/_shared/canonical-mutation";
import type { OperationResponse } from "~/shell/_shared/response";
import { hashTokenBearer } from "~/shell/_shared/token-digest";
import { appendConsentRecordInScope, withSubjectLockInScope } from "~/shell/consent/repo";
import { currentManualPATDisclosure } from "./current-disclosure";
import {
  type ManualPATIssuanceConsumed,
  type ManualPATIssuanceRateLimited,
  makePATIssuanceConsumed,
  makePATRateLimit,
  manualPATIssuanceLimit,
  manualPATIssuanceWindowMinutes,
} from "./errors";
import { getPATIssuanceAdmission, hasConsumedPATRequest, insertPATInScope } from "./repo";

const shortIdBytes = 4;
type MutationResponse<Data extends Schema.Top> = ReturnType<typeof OperationResponse<Data>>["Type"];

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
    lastUsedAt: Option.none(),
    idleExpiresAt: yield* computePatIdleExpiry(createdAt),
    revokedAt: Option.none(),
    createdAt,
  });
  const disclosure = yield* currentManualPATDisclosure(grant).pipe(Effect.orDie);
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

  return { data: IssuedManualPAT.make({ pat, bearer }), next: [] };
});

/** Issues one manual PAT with matching Consent evidence or a typed admission failure. */
export const createManualPAT: CanonicalMutationImplementation<
  CreateManualPATInput,
  MutationResponse<typeof IssuedManualPAT>,
  ManualPATIssuanceConsumed | ManualPATIssuanceRateLimited,
  Crypto.Crypto
> = (input) => withSubjectLockInScope(input.userId, createManualPATInScope(input));
