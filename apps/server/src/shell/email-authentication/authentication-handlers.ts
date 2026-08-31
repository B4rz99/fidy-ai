import { jsonStringSchema } from "~/schema-compatibility";
import { Effect, Option, Redacted, Result, Schema, Semaphore } from "effect";
import { type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { anonymousRequestSource } from "~/shell/_shared/anonymous-source";
import { collectBoundedBytes } from "~/shell/_shared/bounded-bytes";
import { externalEndpoints } from "~/shell/_shared/external-endpoints";
import {
  BrowserLoginPairingInvalidApi,
  BrowserPairingEmailAuthenticationInvalidApi,
  BrowserPairingEmailAuthenticationOriginRejectedApi,
  BrowserPairingEmailAuthenticationPayloadTooLargeApi,
  BrowserPairingEmailAuthenticationUnavailableApi,
  BrowserPairingEmailAuthenticationUnsupportedMediaTypeApi,
  CompleteBrowserPairingEmailAuthenticationPayload,
  StartBrowserPairingEmailAuthenticationPayload,
  WebAuthApi,
  browserLoginPairingInvalidBody,
  browserPairingEmailAuthenticationInvalidBody,
} from "~/web-auth-api";
import { browserPairingEmailAuthentication } from "./pairing-authentication";

const maximumStartBytes = 512;
const maximumCompletionBytes = 256;
const maximumConcurrentStarts = 8;
const maximumConcurrentCompletions = 4;
const startAdmission = Semaphore.makeUnsafe(maximumConcurrentStarts);
const completionAdmission = Semaphore.makeUnsafe(maximumConcurrentCompletions);

const invalid = (): BrowserPairingEmailAuthenticationInvalidApi =>
  BrowserPairingEmailAuthenticationInvalidApi.make(browserPairingEmailAuthenticationInvalidBody);
const originRejected = (): BrowserPairingEmailAuthenticationOriginRejectedApi =>
  BrowserPairingEmailAuthenticationOriginRejectedApi.make(
    browserPairingEmailAuthenticationInvalidBody
  );
const payloadTooLarge = (): BrowserPairingEmailAuthenticationPayloadTooLargeApi =>
  BrowserPairingEmailAuthenticationPayloadTooLargeApi.make(
    browserPairingEmailAuthenticationInvalidBody
  );
const unsupportedMediaType = (): BrowserPairingEmailAuthenticationUnsupportedMediaTypeApi =>
  BrowserPairingEmailAuthenticationUnsupportedMediaTypeApi.make(
    browserPairingEmailAuthenticationInvalidBody
  );
const unavailable = (): BrowserPairingEmailAuthenticationUnavailableApi =>
  BrowserPairingEmailAuthenticationUnavailableApi.make(
    browserPairingEmailAuthenticationInvalidBody
  );
const pairingInvalid = (): BrowserLoginPairingInvalidApi =>
  BrowserLoginPairingInvalidApi.make(browserLoginPairingInvalidBody);

const jsonMediaType = /^application\/json(?:\s*;.*)?$/iu;

const readJsonPayload = Effect.fn(function* <A>(
  request: HttpServerRequest.HttpServerRequest,
  maximumBytes: number,
  schema: Schema.Codec<A, unknown, never, never>
) {
  const { webOrigin } = yield* externalEndpoints.pipe(Effect.orDie);
  if (request.headers.origin !== webOrigin) return yield* originRejected();
  const contentType = request.headers["content-type"];
  if (contentType === undefined || !jsonMediaType.test(contentType)) {
    return yield* unsupportedMediaType();
  }
  const bytes = yield* collectBoundedBytes(request.stream, maximumBytes).pipe(
    Effect.mapError(payloadTooLarge)
  );
  if (Option.isNone(bytes)) return yield* payloadTooLarge();
  const decoded = Schema.decodeResult(jsonStringSchema(schema), {
    onExcessProperty: "error",
  })(new TextDecoder().decode(bytes.value));
  return yield* Result.match(decoded, { onFailure: invalid, onSuccess: Effect.succeed });
});

const handleStart = Effect.fn("EmailAuthentication.handleBrowserPairingStart")(function* (
  request: HttpServerRequest.HttpServerRequest
) {
  const payload = yield* readJsonPayload(
    request,
    maximumStartBytes,
    StartBrowserPairingEmailAuthenticationPayload
  );
  const sourceAddress = Option.getOrElse(anonymousRequestSource(request), () => "unknown");
  const result = yield* browserPairingEmailAuthentication
    .requestCode({
      pairingId: payload.pairingId,
      privateVerifier: payload.privateVerifier,
      email: payload.email,
      sourceAddress,
    })
    .pipe(Effect.catchTag("BrowserLoginPairingInvalid", pairingInvalid));
  return yield* HttpServerResponse.json(result, {
    status: 202,
    headers: { "retry-after": String(result.retryAfterSeconds) },
  }).pipe(Effect.orDie);
});

const handleCompletion = Effect.fn("EmailAuthentication.handleBrowserPairingCompletion")(function* (
  request: HttpServerRequest.HttpServerRequest
) {
  const payload = yield* readJsonPayload(
    request,
    maximumCompletionBytes,
    CompleteBrowserPairingEmailAuthenticationPayload
  );
  const approved = yield* browserPairingEmailAuthentication.submitCode({
    pairingId: payload.pairingId,
    privateVerifier: payload.privateVerifier,
    combinedCode: Redacted.make(payload.combinedCode),
    sourceAddress: Option.getOrElse(anonymousRequestSource(request), () => "unknown"),
  });
  return approved ? { status: "pairing_approved" as const } : yield* invalid();
});

const withStartAdmission = Effect.fn("EmailAuthentication.withStartAdmission")(function* (
  request: HttpServerRequest.HttpServerRequest
) {
  const admitted = yield* startAdmission.withPermitsIfAvailable(1)(handleStart(request));
  return yield* Option.match(admitted, { onNone: unavailable, onSome: Effect.succeed });
});

const withCompletionAdmission = Effect.fn("EmailAuthentication.withCompletionAdmission")(function* (
  request: HttpServerRequest.HttpServerRequest
) {
  const admitted = yield* completionAdmission.withPermitsIfAvailable(1)(handleCompletion(request));
  return yield* Option.match(admitted, { onNone: unavailable, onSome: Effect.succeed });
});

/** Exact-origin, bounded direct-browser handlers for email-assisted pairing approval. */
export const BrowserPairingEmailAuthenticationWebAuthHandlersLive = HttpApiBuilder.group(
  WebAuthApi,
  "browserPairingEmailAuthentication",
  (handlers) =>
    handlers
      .handleRaw("start", ({ request }) => withStartAdmission(request))
      .handleRaw("complete", ({ request }) => withCompletionAdmission(request))
);
