import { registeredConnectionInstitutionIds } from "../src/shell/connections/contract";
import { Clock, Context, Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { OutboundHttpLive } from "./outbound-http/runtime";
import type { TelemetryService } from "../src/shell/observability/contract";
import coreWorker, { UserTransactionCoordinator, makeCoreWorker } from "./core-worker";
/** Direct owner integration retains Core's native reader policy under the test's owning Scope. */
export const fixtureNativeHttpClient = Effect.gen(function* () {
  const clients = yield* Layer.build(OutboundHttpLive).pipe(
    Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch)
  );
  return Context.get(clients, HttpClient.HttpClient);
});

const withMaintenanceExecutor = (worker: typeof coreWorker): typeof coreWorker => ({
  ...worker,
  scheduled: (controller, environment) => {
    const coordinator = new UserTransactionCoordinator(
      {
        id: { name: "core-maintenance-v1" },
        storage: {
          getAlarm: (): ReturnType<DurableObjectStorage["getAlarm"]> => Promise.resolve(null),
          deleteAlarm: (): Promise<void> => Promise.resolve(),
          setAlarm: (): Promise<void> => Promise.reject(new Error("Unused maintenance alarm")),
        },
      },
      environment
    );
    return worker.scheduled(controller, {
      ...environment,
      USER_TRANSACTION_COORDINATOR: {
        getByName: () => ({ fetch: (request) => coordinator.fetch(new Request(request)) }),
      },
    });
  },
});

export const fixtureWorker = withMaintenanceExecutor(coreWorker);
export const makeFixtureWorker = (telemetry: TelemetryService): typeof coreWorker =>
  withMaintenanceExecutor(
    makeCoreWorker({ telemetry, institutions: registeredConnectionInstitutionIds })
  );

export { UserTransactionCoordinator } from "./core-worker";

export const scheduledFixture = {
  fetch(
    request: Request,
    environment: Parameters<typeof coreWorker.scheduled>[1]
  ): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/schedule") {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return Effect.gen(function* () {
      const hourMs = 3_600_000;
      const scheduledTime = Math.floor((yield* Clock.currentTimeMillis) / hourMs) * hourMs;
      return yield* Effect.tryPromise({
        try: () =>
          coreWorker.scheduled(
            { cron: "* * * * *", scheduledTime, noRetry: () => undefined },
            environment
          ),
        catch: () => "schedule-failed" as const,
      }).pipe(
        Effect.match({
          onSuccess: () => new Response(null, { status: 204 }),
          onFailure: () => new Response(null, { status: 503 }),
        })
      );
    }).pipe(Effect.runPromise);
  },
};
