import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { UtcTimestamp } from "~/core/_shared/time";
import { BrowserLoginPairingId } from "~/core/browser-login/reference";
import type { CanonicalRejectedFailure } from "~/shell/_shared/errors";
import { operationPolicy, verifiedWhatsAppHostedOnly } from "~/shell/_shared/operation-policy";
import { NextOperations, OperationResponse } from "~/shell/_shared/response";

/** Stable canonical identity of hosted browser-pairing approval. */
export const browserLoginApprovalOperation = CanonicalOperationId.make(
  "browserLogin.approvePairing"
);

/** Non-enumerating message shared by every invalid public-code approval outcome. */
export const browserLoginApprovalGenericMessage =
  "This pairing is no longer valid. Start again." as const;

/** Generic rejection for any public code that cannot be approved without revealing why. */
export class BrowserLoginPairingApprovalRejected
  extends Schema.ErrorClass<BrowserLoginPairingApprovalRejected>(
    "BrowserLoginPairingApprovalRejected"
  )(
    {
      _tag: Schema.tagDefaultOmit("BrowserLoginPairingApprovalRejected"),
      error: Schema.Struct({
        code: Schema.Literal("validation_failed"),
        message: Schema.Literal(browserLoginApprovalGenericMessage),
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
        message: Schema.Literal(browserLoginApprovalGenericMessage),
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

/** Deliberately accepts text broadly so malformed submissions share the bounded generic refusal. */
export const ApproveBrowserLoginPairingPayload = Schema.Struct({
  publicCode: Schema.String,
}).annotate({ identifier: "ApproveBrowserLoginPairingPayload" });

export const BrowserLoginPairingApproval = Schema.Struct({
  pairingId: BrowserLoginPairingId,
  expiresAt: UtcTimestamp,
}).annotate({ identifier: "BrowserLoginPairingApproval" });

export const BrowserLoginGroup = HttpApiGroup.make("browserLogin").add(
  HttpApiEndpoint.post("approvePairing", "/browser-login/pairings/approve", {
    payload: ApproveBrowserLoginPairingPayload,
    success: OperationResponse(BrowserLoginPairingApproval),
    error: [BrowserLoginPairingApprovalRejected, BrowserLoginPairingApprovalRateLimited],
  })
    .annotate(
      OpenApi.Description,
      "Approve the displayed browser pairing code for this User. The host requires exact explicit " +
        "confirmation before execution; the code is public and is never a browser credential."
    )
    .annotateMerge(
      operationPolicy({
        access: verifiedWhatsAppHostedOnly,
        requiredTier: "free",
        agentConfirmation: "required",
        kind: "mutation",
      })
    )
);
