import { logoutWebSessionEndpoint } from "~/shell/web-session/contract";
import {
  StartedBrowserLoginPairing,
  browserLoginPollingIntervalSeconds,
} from "~/core/browser-login/contract";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { CanonicalOperationId } from "~/core/canonical-operations/contract";
import { UtcTimestamp } from "~/core/_shared/time";
import { BrowserLoginPairingId } from "~/core/browser-login/reference";
import {
  type CanonicalRejectedFailure,
  NextOperations,
  OperationResponse,
} from "~/shell/public-http/contract";
import { operationPolicy, verifiedWhatsAppHostedOnly } from "~/shell/canonical-policy/contract";

/** Stable canonical identity of hosted browser-pairing approval. */
export const browserLoginApprovalOperation = CanonicalOperationId.make(
  "browserLogin.approvePairing"
);

/** Non-enumerating message shared by every invalid public-code approval outcome. */
export const browserLoginApprovalGenericMessage =
  "This pairing is no longer valid. Start again." as const;

/** Generic rejection for any public code that cannot be approved without revealing why. */
export class BrowserLoginPairingApprovalRejected
  extends Schema.Error<BrowserLoginPairingApprovalRejected>("BrowserLoginPairingApprovalRejected")(
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
  extends Schema.Error<BrowserLoginPairingApprovalRateLimited>(
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

const browserLoginUnavailableError = {
  code: "rate_limited",
  message: "El inicio de sesión no está disponible temporalmente. Intenta de nuevo más tarde.",
} as const;

const BrowserLoginUnavailableError = Schema.Struct({
  code: Schema.Literal(browserLoginUnavailableError.code),
  message: Schema.Literal(browserLoginUnavailableError.message),
});

/** Documented 429 shape; the handler adds Retry-After on its raw encoded response. */
export class BrowserLoginRateLimitedApi extends Schema.Error<BrowserLoginRateLimitedApi>(
  "BrowserLoginRateLimitedApi"
)({ error: BrowserLoginUnavailableError }, { httpApiStatus: 429 }) {}

/** Capacity exhaustion intentionally shares the generic public message. */
export class BrowserLoginUnavailableApi extends Schema.Error<BrowserLoginUnavailableApi>(
  "BrowserLoginUnavailableApi"
)({ error: BrowserLoginUnavailableError }, { httpApiStatus: 503 }) {}

/** Shared non-enumerating response body for temporarily unavailable browser login admission. */
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

/** One non-enumerating public refusal for every invalid pairing proof and terminal state. */
export class BrowserLoginPairingInvalidApi extends Schema.Error<BrowserLoginPairingInvalidApi>(
  "BrowserLoginPairingInvalidApi"
)({ error: BrowserLoginPairingInvalidError }, { httpApiStatus: 400 }) {}

/** Polling cadence refusal; the global response adapter derives Retry-After from this body. */
export class BrowserLoginPollingRateLimitedApi extends Schema.Error<BrowserLoginPollingRateLimitedApi>(
  "BrowserLoginPollingRateLimitedApi"
)(
  {
    error: Schema.Struct({
      code: Schema.Literal("rate_limited"),
      retryAfterSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  },
  { httpApiStatus: 429 }
) {}

/** Shared non-enumerating response body for every terminal redemption refusal. */
export const browserLoginPairingInvalidBody = {
  error: browserLoginPairingInvalidError,
} as const;

/** Proof-bearing HTTPS request; malformed field values receive the generic invalid response. */
export const RedeemBrowserLoginPairingPayload = Schema.Struct({
  pairingId: Schema.optional(Schema.Unknown),
  privateVerifier: Schema.optional(Schema.Unknown),
});
export type RedeemBrowserLoginPairingPayload = typeof RedeemBrowserLoginPairingPayload.Type;

/** Correct poll before hosted approval; HTTP 202 distinguishes pending from authenticated. */
export const PendingBrowserLoginPairing = Schema.Struct({
  status: Schema.Literal("pending_approval"),
  expiresAt: UtcTimestamp,
  pollingIntervalSeconds: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(browserLoginPollingIntervalSeconds)
  ),
}).annotate({ identifier: "PendingBrowserLoginPairing", httpApiStatus: 202 });
export type PendingBrowserLoginPairing = typeof PendingBrowserLoginPairing.Type;

/** Successful redemption carries no bearer or User material; the bearer exists only in a cookie. */
export const AuthenticatedBrowserLoginPairing = Schema.Struct({
  status: Schema.Literal("authenticated"),
}).annotate({ identifier: "AuthenticatedBrowserLoginPairing", httpApiStatus: 200 });
export type AuthenticatedBrowserLoginPairing = typeof AuthenticatedBrowserLoginPairing.Type;

/** Direct-browser login operations derived into server routes and one credential-bearing client. */
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
