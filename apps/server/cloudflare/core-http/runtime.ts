import {
  ConnectionInstitutions,
  type registeredConnectionInstitutionIds,
} from "../../src/shell/connections/contract";
import { withErasureRecovery } from "../erasure/runtime";
import type { CoreRejectionBoundary } from "../runtime/operational-health/contract";
import { makeCoreRejectionObserver } from "../runtime/operational-health/runtime";
import { OutboundHttpLive } from "../outbound-http/runtime";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Clock, Context, Effect, Layer, Option } from "effect";
import { decodeTraceParent } from "../../src/shell/observability/operations";
import { workerInternalTraceHeader } from "../runtime/telemetry/contract";
import type { TelemetryService } from "../../src/shell/observability/contract";
import type { CoreHttpHandler } from "./contract";
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
      const clients = yield* Layer.build(OutboundHttpLive).pipe(
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch)
      );
      const response = yield* executeCoreHttp({
        request,
        environment:
          new URL(request.url).pathname === "/internal/titular-erasure"
            ? environment
            : withErasureRecovery(environment),
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
      return response;
    }).pipe(
      Effect.provideService(ConnectionInstitutions, institutions),
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
