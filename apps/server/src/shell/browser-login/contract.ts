import { logoutWebSessionEndpoint } from "~/shell/web-session/contract";
import {
  BrowserLoginPairingId,
  StartedBrowserLoginPairing,
  browserLoginPollingIntervalSeconds,
} from "~/core/browser-login/contract";
import { type Brand, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import { UtcTimestamp } from "~/core/_shared/time";

import {
  type CanonicalRejectedFailure,
  NextOperations,
  OperationResponse,
  omittedTag,
} from "~/shell/public-http/contract";
import { operationPolicy, verifiedWhatsAppHostedOnly } from "~/shell/canonical-policy/contract";

export const browserLoginApprovalOperation = CanonicalOperationId.make(
  "browserLogin.approvePairing"
);

export const browserLoginApprovalGenericMessage =
  "This pairing is no longer valid. Start again." as const;

export class BrowserLoginPairingApprovalRejected
  extends Schema.Error<
    BrowserLoginPairingApprovalRejected,
    Brand.Brand<"BrowserLoginPairingApprovalRejected">
  >("BrowserLoginPairingApprovalRejected")(
    {
      ...omittedTag("BrowserLoginPairingApprovalRejected"),
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

export class BrowserLoginPairingApprovalRateLimited
  extends Schema.Error<
    BrowserLoginPairingApprovalRateLimited,
    Brand.Brand<"BrowserLoginPairingApprovalRateLimited">
  >("BrowserLoginPairingApprovalRateLimited")(
    {
      ...omittedTag("BrowserLoginPairingApprovalRateLimited"),
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

const browserLoginUnavailableError = {
  code: "rate_limited",
  message: "El inicio de sesión no está disponible temporalmente. Intenta de nuevo más tarde.",
} as const;

const BrowserLoginUnavailableError = Schema.Struct({
  code: Schema.Literal(browserLoginUnavailableError.code),
  message: Schema.Literal(browserLoginUnavailableError.message),
});

export class BrowserLoginRateLimitedApi extends Schema.Error<
  BrowserLoginRateLimitedApi,
  Brand.Brand<"BrowserLoginRateLimitedApi">
>("BrowserLoginRateLimitedApi")({ error: BrowserLoginUnavailableError }, { httpApiStatus: 429 }) {}

export class BrowserLoginUnavailableApi extends Schema.Error<
  BrowserLoginUnavailableApi,
  Brand.Brand<"BrowserLoginUnavailableApi">
>("BrowserLoginUnavailableApi")({ error: BrowserLoginUnavailableError }, { httpApiStatus: 503 }) {}

export const browserLoginUnavailableBody = Schema.encodeSync(
  Schema.toCodecJson(BrowserLoginUnavailableApi)
)(BrowserLoginUnavailableApi.make({ error: browserLoginUnavailableError }));

const browserLoginPairingInvalidError = {
  code: "pairing_invalid",
  message: "Esta vinculación ya no es válida. Inicia de nuevo.",
} as const;

const BrowserLoginPairingInvalidError = Schema.Struct({
  code: Schema.Literal(browserLoginPairingInvalidError.code),
  message: Schema.Literal(browserLoginPairingInvalidError.message),
});

export class BrowserLoginPairingInvalidApi extends Schema.Error<
  BrowserLoginPairingInvalidApi,
  Brand.Brand<"BrowserLoginPairingInvalidApi">
>("BrowserLoginPairingInvalidApi")(
  { error: BrowserLoginPairingInvalidError },
  { httpApiStatus: 400 }
) {}

export class BrowserLoginPollingRateLimitedApi extends Schema.Error<
  BrowserLoginPollingRateLimitedApi,
  Brand.Brand<"BrowserLoginPollingRateLimitedApi">
>("BrowserLoginPollingRateLimitedApi")(
  {
    error: Schema.Struct({
      code: Schema.Literal("rate_limited"),
      retryAfterSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  },
  { httpApiStatus: 429 }
) {}

export const browserLoginPairingInvalidBody = {
  error: browserLoginPairingInvalidError,
} as const;

export const RedeemBrowserLoginPairingPayload = Schema.Struct({
  pairingId: Schema.optional(Schema.Unknown),
  privateVerifier: Schema.optional(Schema.Unknown),
});

export type RedeemBrowserLoginPairingPayload = typeof RedeemBrowserLoginPairingPayload.Type;

export const PendingBrowserLoginPairing = Schema.Struct({
  status: Schema.Literal("pending_approval"),
  expiresAt: UtcTimestamp,
  pollingIntervalSeconds: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(browserLoginPollingIntervalSeconds)
  ),
}).annotate({ identifier: "PendingBrowserLoginPairing", httpApiStatus: 202 });

export type PendingBrowserLoginPairing = typeof PendingBrowserLoginPairing.Type;

export const AuthenticatedBrowserLoginPairing = Schema.Struct({
  status: Schema.Literal("authenticated"),
}).annotate({ identifier: "AuthenticatedBrowserLoginPairing", httpApiStatus: 200 });

export type AuthenticatedBrowserLoginPairing = typeof AuthenticatedBrowserLoginPairing.Type;

export const BrowserLoginWebAuthGroup = HttpApiGroup.make("browserLogin")
  .add(
    HttpApiEndpoint.post("startPairing", "/web/pairings", {
      success: StartedBrowserLoginPairing,
      error: [BrowserLoginRateLimitedApi, BrowserLoginUnavailableApi],
    }).annotate(
      OpenApi.Description,
      "Create one short-lived browser login pairing and return its private verifier once."
    )
  )
  .add(
    HttpApiEndpoint.post("redeemPairing", "/web/pairings/redeem", {
      payload: RedeemBrowserLoginPairingPayload,
      success: [PendingBrowserLoginPairing, AuthenticatedBrowserLoginPairing],
      error: [
        BrowserLoginPairingInvalidApi,
        BrowserLoginPollingRateLimitedApi,
        BrowserLoginUnavailableApi,
      ],
    }).annotate(
      OpenApi.Description,
      "Poll one browser pairing and atomically redeem it after hosted approval."
    )
  )
  .add(logoutWebSessionEndpoint);
