import { bancolombiaSandboxAdmission } from "../bancolombia-authentication/runtime";
import { ConnectionSandboxAdmission } from "../connections/contract";
import {
  ConnectionInstitutions,
  type registeredConnectionInstitutionIds,
} from "../../src/shell/connections/contract";

import type { CoreRejectionBoundary } from "../runtime/operational-health/contract";
import { coreRejectionObserver } from "../runtime/operational-health/runtime";
import { OutboundHttpLive } from "../outbound-http/runtime";
import { FetchHttpClient, HttpClient } from "effect/http";
import { Clock, Context, Effect, Layer, ManagedRuntime, Option } from "effect";
import { decodeTraceParent } from "../../src/shell/observability/operations";
import { workerInternalTraceHeader } from "../runtime/telemetry/contract";
import type { TelemetryService } from "../../src/shell/observability/contract";
import type { CoreHttpHandler } from "./contract";
import { executeCoreHttp } from "./internal/http";
import { observeWorkerRequest } from "../runtime/telemetry/operations";

const coreHttpRuntime = ManagedRuntime.make(Layer.empty);

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

export const coreHttpHandler = ({ telemetry, institutions }: CoreComposition): CoreHttpHandler => {
  const observeRejections = coreRejectionObserver();

  return (request, environment) =>
    Effect.gen(function* () {
      const clients = yield* Layer.build(OutboundHttpLive).pipe(
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch)
      );

      const response = yield* executeCoreHttp({
        request,
        environment,
        telemetry,
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
      (program) => coreHttpRuntime.runPromise(program, { signal: request.signal })
    );
};
