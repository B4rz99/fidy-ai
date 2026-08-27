import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import {
  ActivePATList,
  CreateManualPATPayload,
  IssuedPAT,
  PAT,
  PATLifecycleCheck,
  RevokedPAT,
  RevokedPATCount,
  TokenShortId,
} from "~/core/tokens/model";
import { UtcTimestamp } from "~/core/_shared/time";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import {
  ApprovePATPairingPayload,
  ApprovedPATPairing,
  PATPairingReview,
} from "~/core/tokens/pairing";
import { type CanonicalRejectedFailure, NotFound } from "~/shell/_shared/errors";
import {
  freshWebOrVerifiedWhatsAppHosted,
  freshWebSessionOnly,
  operationPolicy,
  webOrHosted,
} from "~/shell/_shared/operation-policy";
import { NextOperations, OperationResponse } from "~/shell/_shared/response";

export const issuanceConsumedMessage =
  "This manual PAT issuance request was already consumed. Start a new reviewed request.";

/** Safe refusal when a retried request cannot redisclose its previously consumed bearer. */
export class ManualPATIssuanceConsumed
  extends Schema.ErrorClass<ManualPATIssuanceConsumed>("ManualPATIssuanceConsumed")(
    {
      _tag: Schema.tagDefaultOmit("ManualPATIssuanceConsumed"),
      error: Schema.Struct({
        code: Schema.Literal("user_action_required"),
        message: Schema.Literal(issuanceConsumedMessage),
      }),
      next: NextOperations,
    },
    { httpApiStatus: 409 }
  )
  implements CanonicalRejectedFailure
{
  readonly canonicalOutcome = "rejected" as const;
}

export const issuanceLimitedMessage =
  "This User has created too many PATs recently. Wait for the retry interval before trying again.";

/** Cheap User-bound refusal preventing unbounded PAT and Consent evidence creation. */
export class ManualPATIssuanceRateLimited
  extends Schema.ErrorClass<ManualPATIssuanceRateLimited>("ManualPATIssuanceRateLimited")(
    {
      _tag: Schema.tagDefaultOmit("ManualPATIssuanceRateLimited"),
      error: Schema.Struct({
        code: Schema.Literal("rate_limited"),
        message: Schema.Literal(issuanceLimitedMessage),
        retryAfterSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
      }),
      next: NextOperations,
    },
    { httpApiStatus: 429 }
  )
  implements CanonicalRejectedFailure
{
  readonly canonicalOutcome = "rejected" as const;
}

export const reviewExpiredMessage =
  "This PAT review is stale or inconsistent. Review the grant again before creating it.";

/** Safe refusal when confirmation no longer matches one recent reviewed absolute expiration. */
export class ManualPATReviewExpired
  extends Schema.ErrorClass<ManualPATReviewExpired>("ManualPATReviewExpired")(
    {
      _tag: Schema.tagDefaultOmit("ManualPATReviewExpired"),
      error: Schema.Struct({
        code: Schema.Literal("user_action_required"),
        message: Schema.Literal(reviewExpiredMessage),
      }),
      next: NextOperations,
    },
    { httpApiStatus: 422 }
  )
  implements CanonicalRejectedFailure
{
  readonly canonicalOutcome = "rejected" as const;
}

const fixedExpirationAlias = Schema.makeFilter<
  Readonly<{
    expiresAt: Readonly<{ epochMilliseconds: number }>;
    idleExpiresAt: Readonly<{ epochMilliseconds: number }>;
  }>
>((pat) =>
  pat.idleExpiresAt.epochMilliseconds === pat.expiresAt.epochMilliseconds
    ? undefined
    : { path: ["idleExpiresAt"], issue: "Compatibility alias must equal fixed expiration" }
);

const PATWithExpirationAlias = Schema.Struct({
  ...PAT.fields,
  idleExpiresAt: UtcTimestamp.annotate({
    description:
      "Deprecated compatibility alias for expiresAt. This fixed value is never renewed by PAT use.",
  }),
}).check(PATLifecycleCheck, fixedExpirationAlias);

export const IssuedManualPATResponse = Schema.Struct({
  ...IssuedPAT.fields,
  pat: PATWithExpirationAlias,
}).annotate({ identifier: "IssuedManualPATResponse" });

const listPATs = HttpApiEndpoint.get("listPATs", "/pats", {
  success: OperationResponse(ActivePATList),
})
  .annotate(
    OpenApi.Description,
    "List safe metadata for the User's currently usable PATs. Credential material and terminal lifecycle history are never returned."
  )
  .annotateMerge(
    operationPolicy({
      access: webOrHosted,
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "query",
    })
  );

const revokePAT = HttpApiEndpoint.delete("revokePAT", "/pats/:shortId", {
  params: Schema.Struct({ shortId: TokenShortId }),
  success: OperationResponse(RevokedPAT),
  error: NotFound,
})
  .annotate(
    OpenApi.Description,
    "Revoke one User-owned PAT by safe short id. Unknown and foreign identifiers are indistinguishable; an owned retry is idempotent."
  )
  .annotateMerge(
    operationPolicy({
      access: freshWebOrVerifiedWhatsAppHosted,
      requiredTier: "free",
      agentConfirmation: "required",
      kind: "mutation",
    })
  );

const revokeAllPATs = HttpApiEndpoint.delete("revokeAllPATs", "/pats", {
  success: OperationResponse(RevokedPATCount),
})
  .annotate(
    OpenApi.Description,
    "Revoke every active PAT and close approved unclaimed PAT authorization for the User. The count describes active PATs only."
  )
  .annotateMerge(
    operationPolicy({
      access: freshWebOrVerifiedWhatsAppHosted,
      requiredTier: "free",
      agentConfirmation: "required",
      kind: "mutation",
    })
  );

const createManualPAT = HttpApiEndpoint.post("createManualPAT", "/pats", {
  payload: CreateManualPATPayload,
  success: OperationResponse(IssuedManualPATResponse),
  error: [ManualPATIssuanceConsumed, ManualPATIssuanceRateLimited, ManualPATReviewExpired],
})
  .annotate(
    OpenApi.Description,
    "Create one PAT after first-party browser review. The response discloses the raw bearer once; retain it securely because Fidy persists only its digest."
  )
  .annotateMerge(
    operationPolicy({
      access: freshWebSessionOnly,
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "mutation",
    })
  );

export const patPairingInspectOperation = CanonicalOperationId.make("pats.inspectPATPairing");
export const patPairingApproveOperation = CanonicalOperationId.make("pats.approvePATPairing");
export const patPairingGenericMessage =
  "This PAT pairing is invalid or no longer available. Start a new request." as const;

/** One generic non-enumerating refusal for malformed, unknown, expired, or cross-User requests. */
export class PATPairingReviewRejected
  extends Schema.ErrorClass<PATPairingReviewRejected>("PATPairingReviewRejected")(
    {
      _tag: Schema.tagDefaultOmit("PATPairingReviewRejected"),
      error: Schema.Struct({
        code: Schema.Literal("validation_failed"),
        message: Schema.Literal(patPairingGenericMessage),
      }),
      next: NextOperations,
    },
    { httpApiStatus: 400 }
  )
  implements CanonicalRejectedFailure
{
  readonly canonicalOutcome = "rejected" as const;
}

/** Bounded review admission failure without revealing whether a submitted code exists. */
export class PATPairingReviewRateLimited
  extends Schema.ErrorClass<PATPairingReviewRateLimited>("PATPairingReviewRateLimited")(
    {
      _tag: Schema.tagDefaultOmit("PATPairingReviewRateLimited"),
      error: Schema.Struct({
        code: Schema.Literal("rate_limited"),
        message: Schema.Literal(patPairingGenericMessage),
        retryAfterSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
      }),
      next: NextOperations,
    },
    { httpApiStatus: 429 }
  )
  implements CanonicalRejectedFailure
{
  readonly canonicalOutcome = "rejected" as const;
}

const inspectPATPairing = HttpApiEndpoint.post("inspectPATPairing", "/pats/pairings/inspect", {
  payload: Schema.Struct({ publicCode: Schema.String }),
  success: OperationResponse(PATPairingReview),
  error: [PATPairingReviewRejected, PATPairingReviewRateLimited],
})
  .annotate(
    OpenApi.Description,
    "Inspect immutable recipient, scopes, fixed lifetime, and deadlines before approving a client-started PAT request."
  )
  .annotateMerge(
    operationPolicy({
      access: freshWebSessionOnly,
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "mutation",
    })
  );

const approvePATPairing = HttpApiEndpoint.post("approvePATPairing", "/pats/pairings/approve", {
  payload: ApprovePATPairingPayload,
  success: OperationResponse(ApprovedPATPairing),
  error: [PATPairingReviewRejected, ManualPATIssuanceRateLimited],
})
  .annotate(
    OpenApi.Description,
    "Approve exactly one reviewed PAT pairing. The initiating client claims the bearer directly; this response contains no credential."
  )
  .annotateMerge(
    operationPolicy({
      access: freshWebSessionOnly,
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "mutation",
    })
  );

/** Fresh authenticated-web operations for manual and direct-client PAT authority. */
export const PATsGroup = HttpApiGroup.make("pats")
  .add(listPATs)
  .add(revokePAT)
  .add(revokeAllPATs)
  .add(createManualPAT)
  .add(inspectPATPairing)
  .add(approvePATPairing);
