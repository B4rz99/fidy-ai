import { Effect, Option, Semaphore } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  type ClaimPATPairingPayload,
  PATPairingApi,
  patPairingInvalidBody,
  patPairingUnavailableBody,
} from "~/pat-pairing-api";
import { anonymousRequestSource } from "~/shell/_shared/anonymous-source";
import { claimPATPairing, startPATPairing } from "./pat-pairing";

const maximumConcurrentStarts = 8;
const maximumConcurrentClaims = 4;
const starts = Semaphore.makeUnsafe(maximumConcurrentStarts);
const claims = Semaphore.makeUnsafe(maximumConcurrentClaims);
const unavailable = HttpServerResponse.json(patPairingUnavailableBody, { status: 503 }).pipe(
  Effect.orDie
);

const handleStart = Effect.fn("PATPairing.handleStart")(function* (
  payload: Parameters<typeof startPATPairing>[0]
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const source = anonymousRequestSource(request);
  if (Option.isNone(source)) return yield* unavailable;
  const admitted = yield* starts.withPermitsIfAvailable(1)(
    startPATPairing(payload, source.value).pipe(
      Effect.withSpan("PATPairing.start"),
      Effect.catchTags({
        PATPairingStartRateLimited: ({ retryAfterSeconds }) =>
          HttpServerResponse.json(patPairingUnavailableBody, {
            status: 429,
            headers: { "retry-after": String(retryAfterSeconds) },
          }).pipe(Effect.orDie),
        PATPairingCapacityExceeded: () => unavailable,
      })
    )
  );
  return yield* Option.match(admitted, { onNone: () => unavailable, onSome: Effect.succeed });
});

const handleClaim = Effect.fn("PATPairing.handleClaim")(function* (
  payload: ClaimPATPairingPayload
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const source = anonymousRequestSource(request);
  if (Option.isNone(source)) return yield* unavailable;
  const admitted = yield* claims.withPermitsIfAvailable(1)(
    claimPATPairing(payload, source.value).pipe(
      Effect.withSpan("PATPairing.claim"),
      Effect.catchTags({
        PATPairingInvalid: () =>
          HttpServerResponse.json(patPairingInvalidBody, { status: 400 }).pipe(Effect.orDie),
        PATPairingPollingRateLimited: ({ retryAfterSeconds }) =>
          HttpServerResponse.json(
            { error: { code: "rate_limited", retryAfterSeconds } },
            {
              status: 429,
              headers: { "retry-after": String(retryAfterSeconds) },
            }
          ).pipe(Effect.orDie),
        PATPairingClaimSourceRateLimited: ({ retryAfterSeconds }) =>
          HttpServerResponse.json(patPairingUnavailableBody, {
            status: 429,
            headers: { "retry-after": String(retryAfterSeconds) },
          }).pipe(Effect.orDie),
      })
    )
  );
  return yield* Option.match(admitted, { onNone: () => unavailable, onSome: Effect.succeed });
});

export const PATPairingHandlersLive = HttpApiBuilder.group(
  PATPairingApi,
  "patPairing",
  (handlers) =>
    handlers
      .handle("start", ({ payload }) => handleStart(payload))
      .handle("claim", ({ payload }) => handleClaim(payload))
);
