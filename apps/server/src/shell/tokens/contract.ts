import type { OwnedStatement } from "~/shell/owner-write/contract";
import {
  type CanonicalCapability,
  CanonicalOperationId,
} from "~/core/canonical-operations/contract";
import { type Option, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import {
  ActivePATList,
  ApprovePATPairingPayload,
  ApprovedPATPairing,
  ClaimedPATPairing,
  CreateManualPATPayload,
  IssuedPAT,
  PAT,
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
} from "~/shell/public-http/contract";
import {
  freshWebOrVerifiedWhatsAppHosted,
  freshWebSessionOnly,
  operationPolicy,
  webOrHosted,
} from "~/shell/canonical-policy/contract";
import { type AuditCredentialOperation } from "~/shell/audit/contract";

export const issuanceConsumedMessage =
  "This manual PAT issuance request was already consumed. Start a new reviewed request.";

/** Safe refusal when a retried request cannot redisclose its previously consumed bearer. */
export class ManualPATIssuanceConsumed
  extends Schema.Error<ManualPATIssuanceConsumed>("ManualPATIssuanceConsumed")(
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
  extends Schema.Error<ManualPATIssuanceRateLimited>("ManualPATIssuanceRateLimited")(
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
  extends Schema.Error<ManualPATReviewExpired>("ManualPATReviewExpired")(
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
  extends Schema.Error<PATPairingReviewRejected>("PATPairingReviewRejected")(
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
  extends Schema.Error<PATPairingReviewRateLimited>("PATPairingReviewRateLimited")(
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

/** One live-authority gate over the `pats` table: its table, predicate, and bindings. */
export type PATAuthority = Readonly<{
  table: "pats";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;

/** Canonical child calls eligible to advance PAT activity; batch envelopes have separate accountability. */
export type AuditedPATOperation = Exclude<
  AuditCredentialOperation,
  "operations.executeAtomicBatch"
>;

/** Exact PAT proof and declared scope to recheck inside the protected atomic unit. */
export type PATSubject = Readonly<{
  patId: string;
  userId: string;
  digest: Uint8Array;
  requiredScope: Option.Option<CanonicalCapability>;
}>;

/**
 * Canonical mutations whose successful canonical audit row gates PAT activity. Reads advance
 * activity through `recordLivePATUse` instead, so the closed set stays mutation-only.
 */
export type AuditedPATMutation = Extract<
  AuditedPATOperation,
  | "ingestion.submitForExtraction"
  | "transactions.createTransaction"
  | "transactions.linkTransactions"
  | "transactions.unlinkTransactions"
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

export class PATPairingRateLimitedApi extends Schema.Error<PATPairingRateLimitedApi>(
  "PATPairingRateLimitedApi"
)({ error: UnavailableError }, { httpApiStatus: 429 }) {}
export class PATPairingUnavailableApi extends Schema.Error<PATPairingUnavailableApi>(
  "PATPairingUnavailableApi"
)({ error: UnavailableError }, { httpApiStatus: 503 }) {}
export const patPairingUnavailableBody = { error: unavailableError } as const;

const invalidError = {
  code: "pairing_invalid",
  message: "This PAT pairing is no longer valid. Start a new request.",
} as const;
const InvalidError = Schema.Struct({
  code: Schema.Literal(invalidError.code),
  message: Schema.Literal(invalidError.message),
});
export class PATPairingInvalidApi extends Schema.Error<PATPairingInvalidApi>(
  "PATPairingInvalidApi"
)({ error: InvalidError }, { httpApiStatus: 400 }) {}
export const patPairingInvalidBody = { error: invalidError } as const;

export class PATPairingPollingRateLimitedApi extends Schema.Error<PATPairingPollingRateLimitedApi>(
  "PATPairingPollingRateLimitedApi"
)(
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

/** Broad but field-bounded proof input so ordinary malformed values receive one generic refusal. */
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

/** Direct no-store API for one User-owned client; it is not the canonical User API. */
export class PATPairingApi extends HttpApi.make("patPairingApi")
  .add(PATPairingDirectGroup)
  .annotate(OpenApi.Title, "fidy-ai PATPairing API") {}

/**
 * A live SQL projection of safe grant references for symmetric Consent evidence. Its columns are
 * id, user_id, request_id and pairing_id; it carries no bearer verifier or mutable lifecycle row.
 * Execute only inside the same atomic unit as the selected revocation or expiry transition.
 */
export type PATGrantSelection = Readonly<{ _tag: "PATGrants"; statement: OwnedStatement }>;

/**
 * A live SQL projection of approved unclaimed grants, exposing only id and user_id. The statement
 * remains bound to the User or bounded expiry selection and is consumed in that transition's unit.
 */
export type PairingGrantSelection = Readonly<{ _tag: "PairingGrants"; statement: OwnedStatement }>;
