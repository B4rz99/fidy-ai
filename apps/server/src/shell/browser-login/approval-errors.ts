import { Schema } from "effect";
import type { CanonicalRejectedFailure } from "~/shell/_shared/errors";
import { NextOperations } from "~/shell/_shared/response";

const genericMessage = "This pairing is no longer valid. Start again." as const;

/** Generic rejection for any public code that cannot be approved without revealing why. */
export class BrowserLoginPairingApprovalRejected
  extends Schema.ErrorClass<BrowserLoginPairingApprovalRejected>(
    "BrowserLoginPairingApprovalRejected"
  )(
    {
      _tag: Schema.tagDefaultOmit("BrowserLoginPairingApprovalRejected"),
      error: Schema.Struct({
        code: Schema.Literal("validation_failed"),
        message: Schema.Literal(genericMessage),
      }),
      next: NextOperations,
    },
    { httpApiStatus: 400 }
  )
  implements CanonicalRejectedFailure
{
  readonly canonicalOutcome = "rejected" as const;
}

/** Generic rejection carrying the stable delay before this User may try another code. */
export class BrowserLoginPairingApprovalRateLimited
  extends Schema.ErrorClass<BrowserLoginPairingApprovalRateLimited>(
    "BrowserLoginPairingApprovalRateLimited"
  )(
    {
      _tag: Schema.tagDefaultOmit("BrowserLoginPairingApprovalRateLimited"),
      error: Schema.Struct({
        code: Schema.Literal("rate_limited"),
        message: Schema.Literal(genericMessage),
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

/** Constructs a non-enumerating approval rejection with no suggested follow-up operation. */
export const browserLoginApprovalRejected = (): BrowserLoginPairingApprovalRejected =>
  BrowserLoginPairingApprovalRejected.make({
    error: { code: "validation_failed", message: genericMessage },
    next: [],
  });

/** Constructs a non-enumerating approval limit response with its retry delay. */
export const browserLoginApprovalRateLimited = (
  retryAfterSeconds: number
): BrowserLoginPairingApprovalRateLimited =>
  BrowserLoginPairingApprovalRateLimited.make({
    error: {
      code: "rate_limited",
      message: genericMessage,
      retryAfterSeconds,
    },
    next: [],
  });
