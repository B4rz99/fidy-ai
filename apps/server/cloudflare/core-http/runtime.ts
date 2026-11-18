import { isStorageBootstrap, isStorageCompatibility } from "../storage-bootstrap/contract";
import { initializeSharedStores } from "../storage-bootstrap/operations";
import { smokeManifest, smokePath, smokeProofAccepted } from "../runtime/release-smoke/contract";
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

const sharedReadiness = Effect.fn(function* (request: Request, environment: CoreHttpEnvironment) {
  if (
    !smokeProofAccepted({ request, secret: environment.SMOKE_PROOF ?? "" }) ||
    environment.CF_VERSION_METADATA === undefined
  ) {
    return new Response(null, { status: 404 });
  }
  const core = {
    workerVersionId: environment.CF_VERSION_METADATA.id,
    gitRevision: environment.RELEASE_GIT_SHA,
    contractDigest: environment.CONTRACT_DIGEST,
  };
  return yield* initializeSharedStores(environment).pipe(
    Effect.map((markers) =>
      Response.json(
        isStorageBootstrap(request) || isStorageCompatibility(request)
          ? { core, markers }
          : { core, manifest: smokeManifest, status: "pending" }
      )
    ),
    Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 })))
  );
});
const storageProbe = Effect.fn(function* (request: Request, environment: CoreHttpEnvironment) {
  const url = new URL(request.url);
  if (
    environment.RECOVERY_ISOLATION === "isolated" &&
    environment.MAINTENANCE !== undefined &&
    (isStorageCompatibility(request) ||
      isStorageBootstrap(request) ||
      (request.method === "GET" && url.pathname === smokePath && url.search === "?readiness=1"))
  ) {
    return Option.some(yield* sharedReadiness(request, environment));
  }
  return Option.none<Response>();
});

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
      const storage = yield* storageProbe(request, environment);
      if (Option.isSome(storage)) return storage.value;
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
