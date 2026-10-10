import { Clock, Effect } from "effect";
import type { TelemetryService } from "../src/shell/observability/contract";
import coreWorker, { CoreMaintenanceCoordinator, makeCoreWorker } from "./core-worker";

/** Owner integration tests retain real D1; native object routing is covered by core-schedule.test.ts. */
const withMaintenanceExecutor = (worker: typeof coreWorker): typeof coreWorker => ({
  ...worker,
  scheduled: (controller, environment) => {
    const coordinator = new CoreMaintenanceCoordinator(
      { id: { name: "core-maintenance-v1" } },
      environment
    );
    return worker.scheduled(controller, {
      ...environment,
      CORE_MAINTENANCE: {
        getByName: () => ({ fetch: (request) => coordinator.fetch(new Request(request)) }),
      },
    });
  },
});

export const fixtureWorker = withMaintenanceExecutor(coreWorker);
export const makeFixtureWorker = (telemetry: TelemetryService): typeof coreWorker =>
  withMaintenanceExecutor(makeCoreWorker(telemetry));

export { CoreMaintenanceCoordinator };

/** Private test-only trigger: exercises the published scheduler and a native local object binding. */
export const scheduledFixture = {
  fetch(
    request: Request,
    environment: Parameters<typeof coreWorker.scheduled>[1]
  ): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/schedule") {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return Effect.gen(function* () {
      const scheduledTime = yield* Clock.currentTimeMillis;
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
