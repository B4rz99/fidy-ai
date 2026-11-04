import { withAuthoritativeStore } from "../sqlite-store/operations";
import {
  bancolombiaSandboxAdmission,
  verifyBancolombiaSandboxAuthentication,
} from "../bancolombia-authentication/runtime";
import { ConnectionSandboxAdmission } from "../connections/contract";
import {
  ConnectionInstitutions,
  type registeredConnectionInstitutionIds,
} from "../../src/shell/connections/contract";
import { measureErasureRecovery, withErasureRecovery } from "../erasure/runtime";
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

const selectedEnvironment = (
  environment: Parameters<CoreHttpHandler>[1]
): Effect.Effect<Option.Option<CoreHttpEnvironment>> =>
  Effect.try(() => withAuthoritativeStore(environment)).pipe(Effect.option);

const isolatedResponse = (
  request: Request,
  environment: Parameters<CoreHttpHandler>[1]
): Option.Option<Response> =>
  recoveryIsolationResponse({
    request,
    environment: {
      mode: Option.fromUndefinedOr(environment.RECOVERY_ISOLATION),
      proof: Option.fromUndefinedOr(environment.SMOKE_PROOF),
    },
  });

export const makeCoreHttp = ({ telemetry, institutions }: CoreComposition): CoreHttpHandler => {
  const observeRejections = makeCoreRejectionObserver();
  return (request, bindings, context) =>
    Effect.gen(function* () {
      const selected = yield* selectedEnvironment(bindings);
      if (Option.isNone(selected)) return new Response(null, { status: 503 });
      const environment = selected.value;
      const isolated = isolatedResponse(request, environment);
      if (Option.isSome(isolated)) return isolated.value;
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
      Effect.provideService(ConnectionSandboxAdmission, bancolombiaSandboxAdmission(bindings)),
      Effect.scoped,
      (work) =>
        Effect.flatMap(Clock.currentTimeMillis, (receivedAtUnixMilliseconds) =>
          observeWorkerRequest(work, {
            environment: bindings,
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
