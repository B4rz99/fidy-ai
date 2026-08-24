import { Schema } from "effect";
import type { CanonicalRejectedFailure } from "~/shell/_shared/errors";
import { NextOperations } from "~/shell/_shared/response";

/** Maximum manual PAT grants one User may create in the rolling admission window. */
export const manualPATIssuanceLimit = 10;
/** Stable rolling window for manual PAT issuance admission. */
export const manualPATIssuanceWindowMinutes = 60;

const issuanceConsumedMessage =
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

/** Builds the safe conflict returned for a consumed issuance request identity. */
export const makePATIssuanceConsumed = (): ManualPATIssuanceConsumed =>
  ManualPATIssuanceConsumed.make({
    error: { code: "user_action_required", message: issuanceConsumedMessage },
    next: [],
  });

const issuanceLimitedMessage =
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

/** Builds the canonical refusal for the current rolling-window retry delay. */
export const makePATRateLimit = (retryAfterSeconds: number): ManualPATIssuanceRateLimited =>
  ManualPATIssuanceRateLimited.make({
    error: {
      code: "rate_limited",
      message: issuanceLimitedMessage,
      retryAfterSeconds,
    },
    next: [],
  });
