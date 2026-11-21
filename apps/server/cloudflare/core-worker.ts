import { backgroundWorkAllowed } from "./release-isolation/operations";
import type { AcceptanceWindowBindings } from "./release-isolation/contract";
import type { SharedBindings } from "./storage-bootstrap/contract";
import type { CoreHttpEnvironment } from "./core-http/contract";
import type { CoreQueueEnvironment } from "./queue/contract";
import { registeredConnectionInstitutionIds } from "../src/shell/connections/contract";
import {
  ScheduledWorkFailed,
  completedCheckStatus,
  maintenanceName,
  watchdogUrl,
} from "./maintenance/contract";
import { inspectNativeQueues, sendCanary } from "./runtime/operational-health/operations";
import { makeCoreHttp } from "./core-http/runtime";
import { coreQueue } from "./queue/runtime";
import { Effect, Result } from "effect";
import { type WorkerTelemetryEnvironment } from "./runtime/telemetry/contract";
import { cloudflareWorkerTelemetry, observeWorkerExecution } from "./runtime/telemetry/operations";

export { Erasure } from "./erasure-store/runtime";

export { Maintenance } from "./maintenance/runtime";

export { ConnectionSynchronizationWorkflow } from "./connections/runtime";

export { Directory } from "./directory/runtime";

export { UserStore } from "./user-store/runtime";

export { BrowserPairingEmailWorkflowV1 } from "./email-authentication/runtime";

export { OperationalCanaryWorkflowV1 } from "./operational-canary-workflow";

export {
  Pricing,
  BillingCollectionWorkflowV1,
  BillingRefundWorkflowV1,
} from "./subscription/runtime";

export { ProactivityDeliveryWorkflow } from "./insights/runtime";

export { StatementExtractionWorkflowV1 } from "./ingestion/runtime";

type CoreEnvironment = CoreHttpEnvironment &
  CoreQueueEnvironment &
  AcceptanceWindowBindings &
  WorkerTelemetryEnvironment &
  Parameters<typeof inspectNativeQueues>[0] &
  Partial<
    Readonly<{
      OPERATIONAL_CANARY_QUEUE: Queue;
      OPENAI_API_KEY: string;
      HOSTED_AI_MODEL: string;
    }>
  >;

type CoreWorker = Readonly<{
  fetch: (
    request: Request,
    environment: CoreEnvironment,
    context?: Pick<ExecutionContext, "waitUntil">
  ) => Promise<Response>;
  scheduled: (controller: ScheduledController, environment: CoreEnvironment) => Promise<void>;
  queue: (batch: MessageBatch<unknown>, environment: CoreEnvironment) => Promise<void>;
}>;

const maintenanceTick = (
  scheduledTime: number
): ((
  executor: NonNullable<SharedBindings["MAINTENANCE"]>,
  url: string
) => Effect.Effect<void, ScheduledWorkFailed>) =>
  Effect.fnUntraced(function* (executor: NonNullable<SharedBindings["MAINTENANCE"]>, url: string) {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        executor.getByName(maintenanceName).fetch(
          new Request(url, {
            method: "POST",
            headers: {
              "x-maintenance-scheduled-at": String(scheduledTime),
              "fidy-native-inspection": "1",
            },
            signal,
          })
        ),
      catch: () => new ScheduledWorkFailed(),
    });

    if (response.status !== completedCheckStatus) return yield* new ScheduledWorkFailed();
  });

export const makeCoreWorker = ({
  telemetry,
  institutions,
}: Parameters<typeof makeCoreHttp>[0]): CoreWorker => ({
  fetch: makeCoreHttp({ telemetry, institutions }),
  queue: (batch, environment) =>
    Effect.runPromise(backgroundWorkAllowed(environment)).then((allowed) => {
      if (allowed) return Effect.runPromise(coreQueue(telemetry)(batch, environment));

      return batch.retryAll({ delaySeconds: 60 });
    }),
  scheduled: (controller, environment) =>
    Effect.gen(function* () {
      if (!(yield* backgroundWorkAllowed(environment))) return;
      const tick = maintenanceTick(controller.scheduledTime);

      const results = yield* Effect.all(
        [
          inspectNativeQueues(environment).pipe(Effect.mapError(() => new ScheduledWorkFailed())),
          environment.ASYNC_HEALTH_ENABLED === "enabled"
            ? Effect.tryPromise({
                try: (signal) => {
                  const queue = environment.OPERATIONAL_CANARY_QUEUE;

                  if (queue === undefined) {
                    return Promise.reject(Error("Missing operational canary Queue"));
                  }

                  return sendCanary({ queue, now: controller.scheduledTime, signal });
                },
                catch: () => new ScheduledWorkFailed(),
              })
            : Effect.void,
          environment.MAINTENANCE === undefined
            ? Effect.logError({
                message:
                  "fidy.operational component=watchdog operation=maintenance state=unbound severity=critical",
              }).pipe(Effect.andThen(Effect.fail(new ScheduledWorkFailed())))
            : tick(environment.MAINTENANCE, watchdogUrl).pipe(
                Effect.tapError(() =>
                  Effect.logError({
                    message:
                      "fidy.operational component=watchdog operation=maintenance state=unavailable severity=critical",
                  })
                )
              ),
        ],
        { concurrency: 3, mode: "result" }
      );

      if (results.some(Result.isFailure)) return yield* new ScheduledWorkFailed();
    }).pipe(
      (work) =>
        observeWorkerExecution(work, {
          environment,
          telemetry,
          operation: "worker.core.scheduled",
        }),
      Effect.runPromise
    ),
});

export default makeCoreWorker({
  telemetry: cloudflareWorkerTelemetry,
  institutions: registeredConnectionInstitutionIds,
});
