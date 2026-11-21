import { UserId } from "~/core/identity/contract";
import type { OwnedStatement } from "~/shell/owner-write/contract";
import { PATActivityHistory } from "~/core/audit/contract";
import {
  type CanonicalCapability,
  CanonicalOperationId,
} from "~/core/canonical-operations/contract";
import { type Brand, Data, type Option, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  ActivePATList,
  ApprovePATPairingPayload,
  ApprovedPATPairing,
  ClaimedPATPairing,
  CreateManualPATPayload,
  IssuedPAT,
  PAT,
  PATActivityMetadata,
  PATLifecycleCheck,
  PATPairingReview,
  PendingPATPairingClaim,
  RevokedPAT,
  RevokedPATCount,
  StartPATPairingPayload,
  StartedPATPairing,
  TokenShortId,
} from "~/core/tokens/contract";
import { UtcTimestamp } from "~/core/_shared/time";
import {
  type CanonicalRejectedFailure,
  NextOperations,
  NotFound,
  OperationResponse,
  Unavailable,
  omittedTag,
} from "~/shell/public-http/contract";
import {
  freshWebOrVerifiedWhatsAppHosted,
  freshWebSessionOnly,
  operationPolicy,
  webOrHosted,
  webSessionOnly,
} from "~/shell/canonical-policy/contract";
import { type AuditCredentialOperation } from "~/shell/audit/contract";

export class ManualPATReauthenticationRequired
  extends Schema.Error<
    ManualPATReauthenticationRequired,
    Brand.Brand<"ManualPATReauthenticationRequired">
  >("ManualPATReauthenticationRequired")(
    {
      ...omittedTag("ManualPATReauthenticationRequired"),
      error: Schema.Struct({
        code: Schema.Literal("user_action_required"),
        reason: Schema.Literal("reauthentication_required"),
        userId: UserId,
      }),
      next: NextOperations,
    },
    { httpApiStatus: 403 }
  )
  implements CanonicalRejectedFailure
{
  readonly canonicalOutcome = "rejected" as const;
}

export const issuanceConsumedMessage =
  "This manual PAT issuance request was already consumed. Start a new reviewed request.";

export class ManualPATIssuanceConsumed
  extends Schema.Error<ManualPATIssuanceConsumed, Brand.Brand<"ManualPATIssuanceConsumed">>(
    "ManualPATIssuanceConsumed"
  )(
    {
      ...omittedTag("ManualPATIssuanceConsumed"),
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

export class ManualPATIssuanceRateLimited
  extends Schema.Error<ManualPATIssuanceRateLimited, Brand.Brand<"ManualPATIssuanceRateLimited">>(
    "ManualPATIssuanceRateLimited"
  )(
    {
      ...omittedTag("ManualPATIssuanceRateLimited"),
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

export class ManualPATReviewExpired
  extends Schema.Error<ManualPATReviewExpired, Brand.Brand<"ManualPATReviewExpired">>(
    "ManualPATReviewExpired"
  )(
    {
      ...omittedTag("ManualPATReviewExpired"),
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
  error: Unavailable,
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

export const PATActivity = Schema.Struct({
  pat: PATActivityMetadata,
  ...PATActivityHistory.fields,
}).annotate({ identifier: "PATActivity" });

export type PATActivity = typeof PATActivity.Type;

export const PATActivityParams = Schema.Struct({ shortId: TokenShortId });

const getPATActivity = HttpApiEndpoint.get("getPATActivity", "/pats/:shortId/activity", {
  params: PATActivityParams,
  success: OperationResponse(PATActivity),
  error: [NotFound, Unavailable],
})
  .annotate(
    OpenApi.Description,
    "Answer activity questions for one of the User's PATs by safe short id, including expired or revoked grants. Returns at most the latest 50 retained canonical outcomes, newest first. Empty history means no retained activity, not that the PAT was never used; retainedSince gives the retention cutoff and hasMore indicates additional retained entries. Never request or supply a bearer."
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
  error: [
    ManualPATReauthenticationRequired,
    ManualPATIssuanceConsumed,
    ManualPATIssuanceRateLimited,
    ManualPATReviewExpired,
  ],
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

export class PATPairingReviewRejected
  extends Schema.Error<PATPairingReviewRejected, Brand.Brand<"PATPairingReviewRejected">>(
    "PATPairingReviewRejected"
  )(
    {
      ...omittedTag("PATPairingReviewRejected"),
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

export class PATPairingReviewRateLimited
  extends Schema.Error<PATPairingReviewRateLimited, Brand.Brand<"PATPairingReviewRateLimited">>(
    "PATPairingReviewRateLimited"
  )(
    {
      ...omittedTag("PATPairingReviewRateLimited"),
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
      access: webSessionOnly,
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
      access: webSessionOnly,
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "mutation",
    })
  );

export const PATsGroup = HttpApiGroup.make("pats")
  .add(listPATs)
  .add(getPATActivity)
  .add(revokePAT)
  .add(revokeAllPATs)
  .add(createManualPAT)
  .add(inspectPATPairing)
  .add(approvePATPairing);

export type PATAuthority = Readonly<{
  table: "pats";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;

export type AuditedPATOperation = Exclude<
  AuditCredentialOperation,
  "operations.executeAtomicBatch"
>;

export type PATSubject = Readonly<{
  patId: string;
  userId: string;
  digest: Uint8Array;
  requiredScope: Option.Option<CanonicalCapability>;
}>;

export type AuditedPATMutation = Extract<
  AuditedPATOperation,
  | "ingestion.submitForExtraction"
  | "ingestion.resolveNeedsReviewItem"
  | "ingestion.skipNeedsReviewItem"
  | "ingestion.abandonStatementSubmission"
  | "transactions.createTransaction"
  | "transactions.linkTransactions"
  | "transactions.unlinkTransactions"
  | "transactions.deleteTransaction"
  | "transactions.updateTransactions"
  | "transactions.updateTransaction"
>;

const unavailableError = {
  code: "rate_limited",
  message: "PAT pairing is temporarily unavailable. Try again later.",
} as const;

const UnavailableError = Schema.Struct({
  code: Schema.Literal(unavailableError.code),
  message: Schema.Literal(unavailableError.message),
});

export class PATPairingRateLimitedApi extends Schema.Error<
  PATPairingRateLimitedApi,
  Brand.Brand<"PATPairingRateLimitedApi">
>("PATPairingRateLimitedApi")({ error: UnavailableError }, { httpApiStatus: 429 }) {}

export class PATPairingUnavailableApi extends Schema.Error<
  PATPairingUnavailableApi,
  Brand.Brand<"PATPairingUnavailableApi">
>("PATPairingUnavailableApi")({ error: UnavailableError }, { httpApiStatus: 503 }) {}

export const patPairingUnavailableBody = { error: unavailableError } as const;

const invalidError = {
  code: "pairing_invalid",
  message: "This PAT pairing is no longer valid. Start a new request.",
} as const;

const InvalidError = Schema.Struct({
  code: Schema.Literal(invalidError.code),
  message: Schema.Literal(invalidError.message),
});

export class PATPairingInvalidApi extends Schema.Error<
  PATPairingInvalidApi,
  Brand.Brand<"PATPairingInvalidApi">
>("PATPairingInvalidApi")({ error: InvalidError }, { httpApiStatus: 400 }) {}

export const patPairingInvalidBody = { error: invalidError } as const;

export class PATPairingPollingRateLimitedApi extends Schema.Error<
  PATPairingPollingRateLimitedApi,
  Brand.Brand<"PATPairingPollingRateLimitedApi">
>("PATPairingPollingRateLimitedApi")(
  {
    error: Schema.Struct({
      code: Schema.Literal("rate_limited"),
      retryAfterSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  },
  { httpApiStatus: 429 }
) {}

const maximumMalformedClaimValueBytes = 256;

const boundedClaimValue = Schema.Unknown.check(
  Schema.makeFilter<unknown>(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximumMalformedClaimValueBytes,
    { expected: `a JSON value no larger than ${maximumMalformedClaimValueBytes} bytes` }
  )
);

export const ClaimPATPairingPayload = Schema.Struct({
  pairingId: Schema.optional(boundedClaimValue),
  privateDeviceCode: Schema.optional(boundedClaimValue),
});

export type ClaimPATPairingPayload = typeof ClaimPATPairingPayload.Type;

export const PATPairingDirectGroup = HttpApiGroup.make("patPairing")
  .add(
    HttpApiEndpoint.post("start", "/pat-pairings", {
      payload: StartPATPairingPayload,
      success: StartedPATPairing,
      error: [PATPairingInvalidApi, PATPairingRateLimitedApi, PATPairingUnavailableApi],
    }).annotate(
      OpenApi.Description,
      "Start one ten-minute PAT pairing and disclose its private claim proof once."
    )
  )
  .add(
    HttpApiEndpoint.post("claim", "/pat-pairings/claim", {
      payload: ClaimPATPairingPayload,
      success: [PendingPATPairingClaim, ClaimedPATPairing],
      error: [
        PATPairingInvalidApi,
        PATPairingPollingRateLimitedApi,
        PATPairingRateLimitedApi,
        PATPairingUnavailableApi,
      ],
    }).annotate(
      OpenApi.Description,
      "Poll or claim one reviewed PAT pairing with the initiating client's private proof."
    )
  );

export class PATPairingApi extends HttpApi.make("patPairingApi")
  .add(PATPairingDirectGroup)
  .annotate(OpenApi.Title, "fidy-ai PATPairing API") {}

export type PATGrantSelection = Data.TaggedEnum<{
  PATGrants: { readonly statement: OwnedStatement };
}>;

export const PATGrantSelection = Data.taggedEnum<PATGrantSelection>();

export type PairingGrantSelection = Data.TaggedEnum<{
  PairingGrants: { readonly statement: OwnedStatement };
}>;

export const PairingGrantSelection = Data.taggedEnum<PairingGrantSelection>();
