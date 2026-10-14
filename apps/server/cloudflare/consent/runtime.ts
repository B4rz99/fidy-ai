import { Clock, Effect, Option, Schema } from "effect";
import { processingConsentTransport } from "../../src/shell/processing-consent/runtime";
import { ProcessingConsentWithdrawal } from "../../src/shell/processing-consent/contract";
import { authenticateWebSession } from "../web-session/operations";
import { protectCanonicalPressure } from "../canonical-admission/operations";
import { boundedJsonBody } from "../http/operations";
import { RequestBodyPolicy } from "../http/contract";
import { captureTraceHeaders } from "../runtime/telemetry/operations";
import { sweepOffers } from "./internal/proactivity-consent";
import { type ConsentUnavailable, ConsentWithdrawalAdmission } from "./contract";
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
const admissionLifetimeMilliseconds = 5000;
type PrivacyRequest = Readonly<{
  request: Request;
  db: D1Database;
  browserOrigin: string;
  coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
}>;
const forwardWithdrawal = (
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
      Schema.decodeUnknownOption(ProcessingConsentWithdrawal, { onExcessProperty: "error" })
    );
    if (Option.isNone(decoded)) {
      return consentResponse(invalidStatus);
    }
    const admission = yield* Schema.decodeEffect(ConsentWithdrawalAdmission)({
      userId: subject.userId,
      sessionId: subject.id,
      digest: Array.from(subject.digest),
      deadlineMilliseconds: (yield* Clock.currentTimeMillis) + admissionLifetimeMilliseconds,
    });
    const headers = yield* captureTraceHeaders;
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ConsentWithdrawalAdmission))(
      admission
    );
    return yield* Effect.tryPromise(() =>
      input.coordinator.getByName(subject.userId).fetch(
        new Request("https://coordinator.internal/consent-withdraw", {
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
      authenticateWebSession({ ...input, current, freshness: "live" })
    );
    if (Option.isNone(subject)) {
      return consentResponse(unauthenticatedStatus);
    }
    return yield* protectCanonicalPressure({
      db: input.db,
      userId: subject.value.userId,
      refused: (response) => Effect.succeed(consentResponse(response.status)),
      work: {
        status: readProcessingConsent({ ...input, subject: subject.value }),
        authorization: readProcessingAuthorization({ ...input, subject: subject.value }),
        withdraw: forwardWithdrawal(input, subject.value),
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
