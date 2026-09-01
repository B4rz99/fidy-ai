import { jsonStringSchema } from "~/schema-compatibility";
import { DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { BrowserLoginPublicCodeInput } from "~/core/browser-login/rules";
import { BackupRecoveryCode } from "~/core/recovery/model";
import { collectBoundedBytes } from "~/shell/_shared/bounded-bytes";
import { TelemetryHttpStatus } from "~/shell/observability/protocol";
import { Telemetry } from "~/shell/observability/telemetry";
import { SupportAccessUnauthorized, SupportAccessVerifier } from "./access";
import { admitSupportRecoveryInvocation } from "./repo";
import { approveSupportRecovery } from "./service";

const maximumSupportRecoveryBodyBytes = 256;
const statusOk = 200;
const statusBadRequest = 400;
const statusUnauthorized = 401;
const statusTooManyRequests = 429;
const statusUnavailable = 503;
const jsonMediaType = /^application\/json(?:\s*;.*)?$/iu;
const TransportPayload = Schema.Struct({
  pairingCode: BrowserLoginPublicCodeInput,
  backupRecoveryCode: BackupRecoveryCode,
});
const decodePayload = Schema.decodeUnknownOption(jsonStringSchema(TransportPayload), {
  onExcessProperty: "error",
});

const successMessage =
  "Recuperación aprobada. Vuelve de inmediato al mismo navegador donde iniciaste la vinculación y continúa allí. No cierres esa pantalla ni compartas información adicional del navegador con soporte.";
const refusalMessage =
  "No pudimos aprobar la recuperación. La información proporcionada o la vinculación no permiten continuar. Si aún conservas tu código de recuperación, inicia una nueva vinculación y vuelve a contactar a soporte. No envíes documentos, datos financieros ni números de tarjeta o cuenta.";
const unavailableMessage =
  "La operación de soporte no está disponible. No se tomó una decisión de recuperación. Escala el incidente por el canal interno.";
const supportRecoveryTransportDescriptor = {
  component: "api",
  operation: "http.supportRecovery",
  trigger: "api",
  spanOperation: "http.server",
  workKind: "http_request",
  metadata: {
    _tag: "Http",
    method: "POST",
    route: "/internal/support-recovery",
    status: Option.none(),
  },
} as const;

const jsonResponse = (
  body: object,
  status: number,
  headers: Record<string, string> = {}
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });

const unauthorized = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.empty({
    status: statusUnauthorized,
    headers: { "cache-control": "no-store" },
  });
const unavailable = (): HttpServerResponse.HttpServerResponse =>
  jsonResponse({ status: "unavailable", message: unavailableMessage }, statusUnavailable);

const readPayload = Effect.fn(function* (request: HttpServerRequest.HttpServerRequest) {
  const contentType = request.headers["content-type"];
  if (contentType === undefined || !jsonMediaType.test(contentType)) return Option.none();
  const bytes = yield* collectBoundedBytes(request.stream, maximumSupportRecoveryBodyBytes).pipe(
    Effect.orElseSucceed(() => Option.none())
  );
  if (Option.isNone(bytes)) return Option.none();
  return decodePayload(new TextDecoder().decode(bytes.value));
});

const handleSupportRecovery = Effect.fn(function* (request: HttpServerRequest.HttpServerRequest) {
  const assertion = request.headers["cf-access-jwt-assertion"];
  if (assertion === undefined || assertion.length === 0) return unauthorized();
  const verifier = yield* SupportAccessVerifier;
  const operatorId = yield* verifier.verify(Redacted.make(assertion));
  const attemptedAt = yield* DateTime.now;
  const admission = yield* admitSupportRecoveryInvocation(operatorId, attemptedAt);
  if (admission._tag === "Limited") {
    return jsonResponse(
      {
        status: "limited",
        message: unavailableMessage,
        retryAfterSeconds: admission.retryAfterSeconds,
      },
      statusTooManyRequests,
      { "retry-after": String(admission.retryAfterSeconds) }
    );
  }
  const payload = yield* readPayload(request);
  if (Option.isNone(payload)) {
    return jsonResponse({ status: "not_approved", message: refusalMessage }, statusBadRequest);
  }
  const outcome = yield* approveSupportRecovery({
    operatorId,
    pairingCode: payload.value.pairingCode,
    backupRecoveryCode: Redacted.make(payload.value.backupRecoveryCode),
  });
  return outcome === "Approved"
    ? jsonResponse({ status: "approved", message: successMessage }, statusOk)
    : jsonResponse({ status: "not_approved", message: refusalMessage }, statusBadRequest);
});

/**
 * Registers the Access-protected private support adapter. It is intentionally absent from every
 * HttpApi declaration, OpenAPI document, generated client, and canonical operation registry.
 */
export const SupportRecoveryPrivateRouteLive = HttpRouter.add(
  "POST",
  "/internal/support-recovery",
  (request) =>
    Effect.gen(function* () {
      const telemetry = yield* Telemetry;
      return yield* telemetry.rootSpan(
        supportRecoveryTransportDescriptor,
        handleSupportRecovery(request).pipe(
          Effect.catchTag("SupportAccessUnauthorized", () => Effect.succeed(unauthorized())),
          Effect.catchCause(() =>
            Effect.logError("Support recovery transport failed").pipe(Effect.as(unavailable()))
          ),
          Effect.tap((response) =>
            telemetry.recordResponseStatus(TelemetryHttpStatus.make(response.status))
          )
        )
      );
    })
);

/** Production assertion verification supplied only to the launched Railway application. */
export const SupportRecoveryAccessLive = SupportAccessVerifier.layer;

/** Test verifier for real-route suites; it accepts one fixed non-secret assertion only. */
export const SupportRecoveryTestAccess = Layer.succeed(
  SupportAccessVerifier,
  SupportAccessVerifier.of({
    verify: (assertion) =>
      Redacted.value(assertion) === "test-support-access-token"
        ? Effect.succeed(
            Schema.decodeSync(Schema.Struct({ issuer: Schema.String, subject: Schema.String }))({
              issuer: "https://test.cloudflareaccess.com",
              subject: "test-operator",
            })
          )
        : Effect.fail(new SupportAccessUnauthorized()),
  })
);
