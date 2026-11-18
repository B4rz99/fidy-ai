import type { SharedBindings } from "./storage-bootstrap/contract";
import { type ErasureRegistry, type ErasureRegistryNamespace } from "./erasure/contract";
import { registeredConnectionInstitutionIds } from "../src/shell/connections/contract";
import type { ProviderEnvironment } from "./provider-authentication/contract";
import type { ProactivityDeliveryWork, ProactivityEnvironment } from "./insights/contract";
import {
  ScheduledWorkFailed,
  completedCheckStatus,
  maintenanceName,
  watchdogUrl,
} from "./maintenance/contract";
import { inspectNativeQueues, sendCanary } from "./runtime/operational-health/operations";
import { makeCoreHttp } from "./core-http/runtime";
import { makeCoreQueue } from "./queue/runtime";
import type { OpenAiEnvironment } from "./ai/contract";
import type {
  BrowserPairingEmailEnvironment,
  EmailReplacementEnvironment,
} from "./email-authentication/contract";
import type { BillingCollectionEnvironment } from "./subscription/contract";
import type { SmokeEnvironment } from "./runtime/release-smoke/contract";
import { Effect, Result } from "effect";
import { type WorkerTelemetryEnvironment } from "./runtime/telemetry/contract";
import { cloudflareWorkerTelemetry, observeWorkerExecution } from "./runtime/telemetry/operations";

export { Erasure } from "./erasure-store/runtime";
export { Maintenance } from "./maintenance/runtime";
export { ConnectionSynchronizationWorkflow } from "./connections/runtime";
export { Directory } from "./directory/runtime";
export { UserStore } from "./user-store/runtime";
export {
  BrowserPairingEmailWorkflowV1,
  EmailReplacementWorkflowV1,
} from "./email-authentication/runtime";
export { OperationalCanaryWorkflowV1 } from "./operational-canary-workflow";
export {
  Pricing,
  BillingCollectionWorkflowV1,
  BillingRefundWorkflowV1,
} from "./subscription/runtime";
export { ProactivityDeliveryWorkflow } from "./insights/runtime";
export { StatementExtractionWorkflowV1 } from "./ingestion/runtime";

type CoreEnvironment = Pick<SharedBindings, "MAINTENANCE"> &
  ProviderEnvironment &
  WorkerTelemetryEnvironment &
  ProactivityEnvironment &
  Readonly<{ CONTRACT_DIGEST: string; RELEASE_GIT_SHA: string }> & {
    readonly OPENAI_API_KEY: OpenAiEnvironment["OPENAI_API_KEY"];
    readonly DB: D1Database;
    readonly USER_TRANSACTION_COORDINATOR: ErasureRegistryNamespace;
    readonly HOSTED_AI_MODEL: string;
    readonly KAPSO_API_KEY: string;
    readonly KAPSO_WEBHOOK_SECRET: string;
    readonly WHATSAPP_BUSINESS_PORTFOLIO_ID: string;
    readonly WHATSAPP_SANDBOX_PHONE_NUMBER_ID: string;
    readonly CLOUDFLARE_ACCESS_ISSUER: string;
    readonly CLOUDFLARE_ACCESS_AUDIENCE: string;
    readonly BROWSER_ORIGIN: string;
    readonly WOMPI_ENVIRONMENT: string;
    readonly WOMPI_PUBLIC_KEY: string;
    readonly WOMPI_PRIVATE_KEY: string;
    readonly WOMPI_INTEGRITY_SECRET: string;
  } & Partial<
    Readonly<{
      RECOVERY_ISOLATION: string;
      SAMPLE_REVIEW_AUDIENCE: string;
      SAMPLE_REVIEWER_EMAIL: string;
      SAMPLE_BUCKET: R2Bucket;
      BILLING_SUPPORT_AUDIENCE: string;
      PRICING_PUBLISH_AUDIENCE: string;
      PRICING: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
      ERASURE_SUPPORT_AUDIENCE: string;
      ERASURE_REQUIRED: string;
      ERASURE_BUCKET: R2Bucket;
      ERASURE_REGISTRY: ErasureRegistry;
      ERASURE_REGISTRY_COORDINATOR: ErasureRegistryNamespace;
      BILLING_REFUND_WORKFLOW: Workflow;
      WOMPI_DAVIPLATA_ACTIVATED: string;
      WOMPI_DAVIPLATA_OTP_SEND_URL: string;
      WOMPI_DAVIPLATA_OTP_CONFIRM_URL: string;
      ASYNC_HEALTH_ENABLED: "enabled";
      ASYNC_DEAD_LETTERS: Pick<Queue, "metrics">;
      FORWARDED_EMAIL_QUEUE: Pick<Queue, "metrics">;
      EMAIL_REPLACEMENT_HEALTH_QUEUE: Pick<Queue, "metrics">;
      OPERATIONAL_CANARY_QUEUE: Queue;
      OPERATIONAL_CANARY_QUEUE_NAME: string;
      OPERATIONAL_CANARY_WORKFLOW: Workflow;
    }>
  > &
  Partial<SmokeEnvironment> &
  Partial<Omit<BrowserPairingEmailEnvironment, "DB">> &
  Partial<Omit<EmailReplacementEnvironment, "DB" | "RESEND_API_KEY">> &
  /** Private R2 binding for staged statement bytes; absent fails the transport closed. */
  Partial<
    Readonly<{
      EMAIL_BUCKET: R2Bucket;
      STATEMENT_STAGING_BUCKET: R2Bucket;
      STATEMENT_EXTRACTION_QUEUE: Queue;
      STATEMENT_EXTRACTION_WORKFLOW: Workflow;
      HOSTED_WHATSAPP_QUEUE: Queue;
      WEEKLY_DELIVERY_QUEUE: Queue<ProactivityDeliveryWork>;
      WEEKLY_DELIVERY_WORKFLOW: Workflow<ProactivityDeliveryWork>;
    }>
  > &
  Partial<
    Pick<
      BillingCollectionEnvironment,
      "BILLING_COLLECTION_QUEUE" | "BILLING_COLLECTION_WORKFLOW" | "WOMPI_EVENT_SECRET"
    >
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
  queue: (batch, environment) => makeCoreQueue(telemetry)(batch, environment),
  scheduled: (controller, environment) =>
    Effect.gen(function* () {
      if (environment.RECOVERY_ISOLATION === "isolated") return;
      const tick = maintenanceTick(controller.scheduledTime);
      const results = yield* Effect.all(
        [
          inspectNativeQueues(environment),
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
