import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import {
  ClaimedPATPairing,
  PendingPATPairingClaim,
  StartPATPairingPayload,
  StartedPATPairing,
} from "~/core/tokens/pairing";

const unavailableError = {
  code: "rate_limited",
  message: "PAT pairing is temporarily unavailable. Try again later.",
} as const;
const UnavailableError = Schema.Struct({
  code: Schema.Literal(unavailableError.code),
  message: Schema.Literal(unavailableError.message),
});

export class PATPairingRateLimitedApi extends Schema.ErrorClass<PATPairingRateLimitedApi>(
  "PATPairingRateLimitedApi"
)({ error: UnavailableError }, { httpApiStatus: 429 }) {}
export class PATPairingUnavailableApi extends Schema.ErrorClass<PATPairingUnavailableApi>(
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
export class PATPairingInvalidApi extends Schema.ErrorClass<PATPairingInvalidApi>(
  "PATPairingInvalidApi"
)({ error: InvalidError }, { httpApiStatus: 400 }) {}
export const patPairingInvalidBody = { error: invalidError } as const;

export class PATPairingPollingRateLimitedApi extends Schema.ErrorClass<PATPairingPollingRateLimitedApi>(
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
      error: [PATPairingRateLimitedApi, PATPairingUnavailableApi],
    }).annotate(
      OpenApi.Description,
      "Start one ten-minute PAT pairing and disclose its private claim proof once."
    )
  )
  .add(
    HttpApiEndpoint.post("claim", "/pat-pairings/claim", {
      payload: ClaimPATPairingPayload,
      success: [PendingPATPairingClaim, ClaimedPATPairing],
      error: [PATPairingInvalidApi, PATPairingPollingRateLimitedApi, PATPairingUnavailableApi],
    }).annotate(
      OpenApi.Description,
      "Poll or claim one reviewed PAT pairing with the initiating client's private proof."
    )
  );

/** Direct no-store API for one User-owned client; it is not the canonical User API. */
export class PATPairingApi extends HttpApi.make("patPairingApi")
  .add(PATPairingDirectGroup)
  .annotate(OpenApi.Title, "fidy-ai PATPairing API") {}
