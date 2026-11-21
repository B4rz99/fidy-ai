import { webAuthenticationEndpoints } from "../../src/shell/web-authentication/contract";
import { Cause, Data, Effect, Option } from "effect";
import type { HttpClient } from "effect/http";
import { supportRecoveryPath } from "../recovery/contract";
import { patRoute } from "../tokens/operations";
import type {
  ClassifiedFailure,
  SpanDescriptor,
  TelemetryService,
} from "../../src/shell/observability/contract";

const SpanMetadata = Data.taggedEnum<SpanDescriptor["metadata"]>();

const ClassifiedFailureCase = Data.taggedEnum<ClassifiedFailure>();

export const ownsWebAuthenticationPath = (path: string): boolean =>
  path === supportRecoveryPath ||
  patRoute(path) ||
  Object.values(webAuthenticationEndpoints).some((endpoint) => endpoint.path === path);

const unavailable = (): Response =>
  Response.json(
    { status: "unavailable" },
    {
      status: 503,
      headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
    }
  );

const methodNotAllowed = (): Response =>
  Response.json(
    { status: "method_not_allowed" },
    {
      status: 405,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        allow: "GET",
      },
    }
  );

export const supportResponse = ({
  request,
  support,
  telemetry,
}: Readonly<{
  request: Request;
  support: Effect.Effect<Response, never, HttpClient.HttpClient>;
  telemetry: TelemetryService;
}>): Effect.Effect<Response, never, HttpClient.HttpClient> => {
  if (request.method !== "POST") return Effect.succeed(methodNotAllowed());

  return telemetry.rootSpan(
    {
      component: "api",
      operation: "http.supportRecovery",
      trigger: "api",
      spanOperation: "http.server",
      workKind: "http_request",
      metadata: SpanMetadata.Http({
        method: "POST",
        route: supportRecoveryPath,
        status: Option.none(),
      }),
    },
    support.pipe(
      Effect.catchCauseIf(Cause.hasDies, () =>
        telemetry
          .captureFailure(
            ClassifiedFailureCase.Defect({
              component: "api",
              operation: "http.supportRecovery",
              error: "unexpected_defect",
              cause: undefined,
            })
          )
          .pipe(Effect.as(unavailable()))
      )
    )
  );
};
