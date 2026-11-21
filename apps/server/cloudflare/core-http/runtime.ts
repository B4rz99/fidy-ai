import { routeSessionRequest } from "../directory/operations";
import { isStorageBootstrap, isStorageCompatibility } from "../storage-bootstrap/contract";
import { initializeSharedStores } from "../storage-bootstrap/operations";
import {
  smokeManifest,
  smokePath,
  smokeProofAccepted,
  smokeVersionHeader,
} from "../runtime/release-smoke/contract";
import {
  bancolombiaSandboxAdmission,
  verifyBancolombiaSandboxAuthentication,
} from "../bancolombia-authentication/runtime";
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
import type { CoreHttpEnvironment, CoreHttpHandler } from "./contract";
import { executeCoreHttp } from "./internal/http";
import { observeWorkerRequest } from "../runtime/telemetry/operations";
import {
  closedHostEnvironment,
  fixtureChargeReceipt,
  isAcceptanceReceipt,
  isAcceptanceWindow,
  isPerformanceEvidence,
  performanceEvidenceAdmitted,
  releaseAdmission,
  renewAcceptanceWindow,
} from "../release-isolation/operations";

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

const performanceProbe = Effect.fn(function* (request: Request, environment: CoreHttpEnvironment) {
  const valid = yield* performanceEvidenceAdmitted({
    request,
    environment,
    boundary: "core",
    now: yield* Clock.currentTimeMillis,
  });

  return Option.some(
    valid
      ? yield* routeSessionRequest({ request, environment })
      : new Response(null, { status: 404 })
  );
});

const readinessPath = (request: Request, url: URL): boolean =>
  isStorageCompatibility(request) ||
  isStorageBootstrap(request) ||
  (request.method === "GET" && url.pathname === smokePath && url.search === "?readiness=1");

const storageProbe = Effect.fn(function* (request: Request, environment: CoreHttpEnvironment) {
  if (isPerformanceEvidence(request)) return yield* performanceProbe(request, environment);
  const url = new URL(request.url);

  const readable =
    environment.RECOVERY_ISOLATION === "isolated"
      ? readinessPath(request, url)
      : environment.NATIVE_STORAGE_ADMISSION === "open" &&
        environment.RECOVERY_ISOLATION === "" &&
        isStorageCompatibility(request);

  if (environment.MAINTENANCE !== undefined && readable) {
    return Option.some(yield* sharedReadiness(request, environment));
  }

  return Option.none<Response>();
});

const consumeVersionOverride = (request: Request): Request => {
  if (!request.headers.has(smokeVersionHeader)) return request;
  const headers = new Headers(request.headers);
  headers.delete(smokeVersionHeader);

  return new Request(request, { headers });
};

export const coreHttpHandler = ({ telemetry, institutions }: CoreComposition): CoreHttpHandler => {
  const observeRejections = coreRejectionObserver();

  return (incoming, installed) => {
    const environment = closedHostEnvironment({
      request: incoming,
      environment: installed,
      boundary: "core",
    });

    return Effect.gen(function* () {
      const admission = yield* releaseAdmission(incoming, environment, "core");

      if (Option.isSome(admission.denial)) return admission.denial.value;
      const request = consumeVersionOverride(admission.request);

      if (isAcceptanceReceipt(request)) return yield* fixtureChargeReceipt(request, environment);

      if (isAcceptanceWindow(request)) return yield* renewAcceptanceWindow(request, environment);
      const storage = yield* storageProbe(request, environment);

      if (Option.isSome(storage)) return storage.value;

      const clients = yield* Layer.build(OutboundHttpLive).pipe(
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch)
      );

      const response = yield* executeCoreHttp({
        bankAuthentication: verifyBancolombiaSandboxAuthentication(environment),
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
                value: Option.fromNullOr(incoming.headers.get(workerInternalTraceHeader)),
                receivedAtUnixMilliseconds,
              })
            ),
          })
        ),
      (program) => coreHttpRuntime.runPromise(program, { signal: incoming.signal })
    );
  };
};
