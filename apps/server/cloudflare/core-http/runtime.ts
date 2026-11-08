import {
  bancolombiaSandboxAdmission,
  verifyBancolombiaSandboxAuthentication,
} from "../bancolombia-authentication/runtime";
import { ConnectionSandboxAdmission } from "../connections/contract";
import {
  ConnectionInstitutions,
  type registeredConnectionInstitutionIds,
} from "../../src/shell/connections/contract";
import {
  measureErasureRecovery,
  protectedStorageAvailable,
  withErasureRecovery,
} from "../erasure/runtime";
import type { CoreRejectionBoundary } from "../runtime/operational-health/contract";
import { makeCoreRejectionObserver } from "../runtime/operational-health/runtime";
import { OutboundHttpLive } from "../outbound-http/runtime";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Clock, Context, Effect, Layer, Option } from "effect";
import { decodeTraceParent } from "../../src/shell/observability/operations";
import { workerInternalTraceHeader } from "../runtime/telemetry/contract";
import type { TelemetryService } from "../../src/shell/observability/contract";
import type { CoreHttpEnvironment, CoreHttpHandler } from "./contract";
import { acceptedWorkPublisher, executeCoreHttp } from "./internal/http";
import { observeWorkerRequest } from "../runtime/telemetry/operations";
import { recoveryIsolationResponse } from "../release-isolation/operations";

const rejectionBoundary = (request: Request): CoreRejectionBoundary => {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/mcp") return "mcp";
  return pathname === "/providers/kapso/callback" || pathname === "/providers/wompi/billing-events"
    ? "providerCallback"
    : "http";
};

type CoreComposition = Readonly<{
  telemetry: TelemetryService;
  institutions: typeof registeredConnectionInstitutionIds;
}>;

const unavailableStatus = 503;
const healthReadiness = (
  input: Readonly<{
    request: Request;
    environment: CoreHttpEnvironment;
  }>
): Effect.Effect<Option.Option<Response>> => {
  const binding = input.environment.PROTECTED_STORAGE;
  if (
    input.request.method !== "GET" ||
    new URL(input.request.url).pathname !== "/health" ||
    binding === undefined
  ) {
    return Effect.succeedNone;
  }
  return protectedStorageAvailable(binding).pipe(
    Effect.map((available) =>
      available
        ? Option.none()
        : Option.some(
            Response.json(
              { status: "unavailable" },
              { status: unavailableStatus, headers: { "cache-control": "no-store" } }
            )
          )
    )
  );
};

export const makeCoreHttp = ({ telemetry, institutions }: CoreComposition): CoreHttpHandler => {
  const observeRejections = makeCoreRejectionObserver();
  return (request, environment, context) =>
    Effect.gen(function* () {
      const isolated = recoveryIsolationResponse({
        request,
        environment: {
          mode: Option.fromUndefinedOr(environment.RECOVERY_ISOLATION),
          proof: Option.fromUndefinedOr(environment.SMOKE_PROOF),
        },
      });
      if (Option.isSome(isolated)) return isolated.value;
      const readiness = yield* healthReadiness({ request, environment });
      if (Option.isSome(readiness)) return readiness.value;
      const recovery = measureErasureRecovery(environment);
      const clients = yield* Layer.build(OutboundHttpLive).pipe(
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch)
      );
      const response = yield* executeCoreHttp({
        bankAuthentication: verifyBancolombiaSandboxAuthentication(environment),
        request,
        environment:
          new URL(request.url).pathname === "/internal/titular-erasure"
            ? environment
            : recovery.environment,
        telemetry,
        publish: acceptedWorkPublisher({
          environment: withErasureRecovery(environment),
          context: Option.fromUndefinedOr(context),
        }),
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, Context.get(clients, HttpClient.HttpClient))
      );
      yield* observeRejections({
        status: response.status,
        boundary: rejectionBoundary(request),
        now: yield* Clock.currentTimeMillis,
      });
      return recovery.respond(response);
    }).pipe(
      Effect.provideService(ConnectionInstitutions, institutions),
      Effect.provideService(ConnectionSandboxAdmission, bancolombiaSandboxAdmission(environment)),
      Effect.scoped,
      (work) =>
        Effect.flatMap(Clock.currentTimeMillis, (receivedAtUnixMilliseconds) =>
          observeWorkerRequest(work, {
            environment,
            telemetry,
            operation: "worker.core.fetch",
            parent: Option.getOrUndefined(
              decodeTraceParent({
                value: Option.fromNullOr(request.headers.get(workerInternalTraceHeader)),
                receivedAtUnixMilliseconds,
              })
            ),
          })
        ),
      Effect.runPromise
    );
};
