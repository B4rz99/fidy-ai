import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import {
  CreateManualPATPayload,
  IssuedManualPAT,
  PAT,
  PATLifecycleCheck,
} from "~/core/tokens/model";
import { UtcTimestamp } from "~/core/_shared/time";
import type { CanonicalRejectedFailure } from "~/shell/_shared/errors";
import { freshWebSessionOnly, operationPolicy } from "~/shell/_shared/operation-policy";
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
  ...IssuedManualPAT.fields,
  pat: PATWithExpirationAlias,
}).annotate({ identifier: "IssuedManualPATResponse" });

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

/** Fresh authenticated-web operations that create and disclose PAT authority. */
export const PATsGroup = HttpApiGroup.make("pats").add(createManualPAT);
