import { handleErasureRequest } from "../erasure/runtime";
import { projections as erasureProjections } from "./internal/erasure";
import { makeErasureStore } from "../erasure-store/runtime";
import type { ErasureStore } from "../erasure-store/contract";
import { Clock, Effect, Option, Schema } from "effect";
import { processingConsentTransport } from "../../src/shell/processing-consent/runtime";
import {
  PrivacyTransactionRequest,
  ProcessingConsentRenewal,
  ProcessingConsentWithdrawal,
} from "../../src/shell/processing-consent/contract";
import { readPrivacyTransactions } from "../transactions/operations";
import { authenticateBoundWebSession } from "../web-session/operations";
import { protectCanonicalPressure } from "../canonical-admission/operations";
import { boundedJsonBody } from "../http/operations";
import { RequestBodyPolicy } from "../http/contract";
import { captureTraceHeaders } from "../runtime/telemetry/operations";
import { sweepOffers } from "./internal/proactivity-consent";
import {
  ConsentRenewalAdmission,
  type ConsentUnavailable,
  ConsentWithdrawalAdmission,
} from "./contract";
import {
  consentResponse,
  readProcessingAuthorization,
  readProcessingConsent,
} from "./internal/browser";

import type { AuthenticatedWebSession } from "../web-session/contract";

const forbiddenStatus = 403;
const notFoundStatus = 404;
const methodNotAllowedStatus = 405;
const invalidStatus = 400;
const unauthenticatedStatus = 401;
const unavailableStatus = 503;
const resourceLimitedStatus = 429;
const admissionLifetimeMilliseconds = 5000;
type PrivacyRequest = Readonly<{
  request: Request;
  db: D1Database;
  browserOrigin: string;
  coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
}>;
const pressureResponse = (request: Request, response: Response): Response => {
  if (request.method !== "GET" || response.status !== resourceLimitedStatus) {
    return consentResponse(response.status);
  }
  response.headers.set("cache-control", "no-store");
  return response;
};
const readTransactions = (
  input: PrivacyRequest,
  subject: AuthenticatedWebSession
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const policy = yield* Schema.decodeEffect(RequestBodyPolicy)({
      maximumBytes: 1024,
      deadlineMilliseconds: 2000,
    });
    const body = yield* boundedJsonBody({ request: input.request, policy, schema: Schema.Unknown });
    const decoded = Option.flatMap(
      body,
      Schema.decodeUnknownOption(PrivacyTransactionRequest, { onExcessProperty: "error" })
    );
    if (Option.isNone(decoded)) return consentResponse(invalidStatus);
    return yield* readPrivacyTransactions({ db: input.db, subject, request: decoded.value });
  }).pipe(Effect.orElseSucceed(() => consentResponse(unavailableStatus)));
const forwardDecision = (
  input: PrivacyRequest,
  subject: AuthenticatedWebSession,
  operation: "withdraw" | "renew"
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const policy = yield* Schema.decodeEffect(RequestBodyPolicy)({
      maximumBytes: 1024,
      deadlineMilliseconds: 2000,
    });
    const body = yield* boundedJsonBody({ request: input.request, policy, schema: Schema.Unknown });
    const decoded = Option.flatMap(
      body,
      Schema.decodeUnknownOption(
        operation === "renew" ? ProcessingConsentRenewal : ProcessingConsentWithdrawal,
        { onExcessProperty: "error" }
      )
    );
    if (Option.isNone(decoded)) {
      return consentResponse(invalidStatus);
    }
    const admissionSchema =
      operation === "renew" ? ConsentRenewalAdmission : ConsentWithdrawalAdmission;
    const admission = yield* Schema.decodeEffect(admissionSchema)({
      userId: subject.userId,
      sessionId: subject.id,
      digest: Array.from(subject.digest),
      deadlineMilliseconds: (yield* Clock.currentTimeMillis) + admissionLifetimeMilliseconds,
      ...(operation === "renew" ? { renewal: decoded.value } : {}),
    });
    const headers = yield* captureTraceHeaders;
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(admissionSchema))(admission);
    return yield* Effect.tryPromise(() =>
      input.coordinator.getByName(subject.userId).fetch(
        new Request(`https://coordinator.internal/consent-${operation}`, {
          method: "POST",
          headers,
          body: encoded,
          signal: input.request.signal,
        })
      )
    );
  }).pipe(Effect.orElseSucceed(() => consentResponse(unavailableStatus)));

/** Resolve cookie-only privacy authority without demanding withdrawn Consent or a purchased plan. */
export const handleProcessingConsentRequest = (input: PrivacyRequest): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (input.request.headers.get("origin") !== input.browserOrigin) {
      return consentResponse(forbiddenStatus);
    }
    const url = new URL(input.request.url);
    const transport = processingConsentTransport(url.pathname);
    if (Option.isNone(transport)) {
      return consentResponse(notFoundStatus);
    }
    if (input.request.method !== transport.value.method) {
      return consentResponse(methodNotAllowedStatus);
    }
    if (url.searchParams.size !== 0) {
      return consentResponse(invalidStatus);
    }
    const current = yield* Clock.currentTimeMillis;
    const subject = yield* Effect.tryPromise(() =>
      authenticateBoundWebSession({
        ...input,
        current,
        freshness: ["transactions", "erase", "renew"].includes(transport.value.operation)
          ? "fresh"
          : "live",
      })
    );
    if (Option.isNone(subject)) {
      return consentResponse(unauthenticatedStatus);
    }
    return yield* protectCanonicalPressure({
      db: input.db,
      userId: subject.value.userId,
      refused: (response) => Effect.succeed(pressureResponse(input.request, response)),
      work: {
        erase: handleErasureRequest(input),
        status: readProcessingConsent({ ...input, subject: subject.value }),
        authorization: readProcessingAuthorization({ ...input, subject: subject.value }),
        transactions: readTransactions(input, subject.value),
        withdraw: forwardDecision(input, subject.value, "withdraw"),
        renew: forwardDecision(input, subject.value, "renew"),
      }[transport.value.operation],
    });
  }).pipe(Effect.orElseSucceed(() => consentResponse(unavailableStatus)));

/** Execute the fixed undecided-offer retention policy against the bound Core database and authoritative runtime clock. Maintenance cannot choose legal-evidence deletion or another retention period. */
export const sweepProactivityConsentOffers = (
  db: D1Database
): Effect.Effect<void, ConsentUnavailable> =>
  Effect.gen(function* () {
    const nowEpochMs = yield* Clock.currentTimeMillis;
    yield* sweepOffers({ db, nowEpochMs });
  });

export const makeConsentErasureStores = (db: D1Database): ReadonlyArray<ErasureStore> =>
  erasureProjections.map((projection) => makeErasureStore({ db, projection }));
