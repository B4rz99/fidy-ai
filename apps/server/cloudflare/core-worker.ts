import type { GoogleEnvironment } from "./provider-authentication/contract";
import type { ProactivityDeliveryWork, ProactivityEnvironment } from "./insights/contract";
import type { CoreMaintenanceInput } from "./maintenance/contract";
import { runCoreMaintenance } from "./maintenance/runtime";
import { makeCoreHttp } from "./core-http/runtime";
import { makeCoreQueue } from "./queue/runtime";
import type { WorkersAiEnvironment } from "./ai/contract";
import type {
  BrowserPairingEmailEnvironment,
  EmailReplacementEnvironment,
  OnboardingEmailEnvironment,
} from "./email-authentication/contract";
import type { BillingCollectionEnvironment } from "./subscription/contract";
import type { SmokeEnvironment } from "./runtime/release-smoke/contract";
import type { TelemetryService } from "../src/shell/observability/contract";
import { Effect, Option } from "effect";
import { type WorkerTelemetryEnvironment } from "./runtime/telemetry/contract";
import { cloudflareWorkerTelemetry, observeWorkerExecution } from "./runtime/telemetry/operations";

export {
  BrowserPairingEmailWorkflowV1,
  EmailReplacementWorkflowV1,
  OnboardingEmailWorkflowV1,
} from "./email-authentication/runtime";
export { OperationalCanaryWorkflowV1 } from "./operational-canary-workflow";
export {
  BillingCollectionWorkflowV1,
  BillingRefundWorkflowV1,
  runBillingCollectionWorkflow,
} from "./subscription/runtime";
export { ProactivityDeliveryWorkflow } from "./insights/runtime";
export { UserTransactionCoordinator } from "./transactions/runtime";
export { ReleaseSmokeWorkflowV1 } from "./runtime/release-smoke/runtime";
export { StatementExtractionWorkflowV1 } from "./ingestion/runtime";

type CoreEnvironment = GoogleEnvironment &
  WorkerTelemetryEnvironment &
  ProactivityEnvironment &
  Readonly<{ CONTRACT_DIGEST: string; RELEASE_GIT_SHA: string }> & {
    readonly AI: WorkersAiEnvironment["AI"];
    readonly DB: D1Database;
    readonly USER_TRANSACTION_COORDINATOR: Readonly<{
      getByName: (name: string) => Pick<Fetcher, "fetch">;
    }>;
    readonly HOSTED_AI_MODEL: string;
    readonly KAPSO_API_KEY: string;
    readonly KAPSO_WEBHOOK_SECRET: string;
    readonly WHATSAPP_BUSINESS_PORTFOLIO_ID: string;
    readonly CLOUDFLARE_ACCESS_ISSUER: string;
    readonly CLOUDFLARE_ACCESS_AUDIENCE: string;
    readonly BROWSER_ORIGIN: string;
    readonly WOMPI_ENVIRONMENT: string;
    readonly WOMPI_PUBLIC_KEY: string;
    readonly WOMPI_PRIVATE_KEY: string;
    readonly WOMPI_INTEGRITY_SECRET: string;
  } & Partial<
    Readonly<{
      BILLING_SUPPORT_AUDIENCE: string;
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
      OPERATOR_ALERT_EMAIL: string;
    }>
  > &
  Partial<SmokeEnvironment> &
  Partial<Omit<OnboardingEmailEnvironment, "DB">> &
  Partial<Omit<BrowserPairingEmailEnvironment, "DB" | "RESEND_API_KEY">> &
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

const weeklyMaintenanceInput = (
  environment: CoreEnvironment
): Pick<
  CoreMaintenanceInput,
  | "WEEKLY_DELIVERY_QUEUE"
  | "WEEKLY_DELIVERY_WORKFLOW"
  | "WEEKLY_SUMMARY_ENABLED"
  | "WEEKLY_SUMMARY_TEMPLATE_JSON"
  | "WEEKLY_QUESTION_TEMPLATE_JSON"
  | "PROACTIVITY_ASK_AFTER"
  | "PROACTIVITY_PAUSE_AFTER"
> => ({
  ...(environment.WEEKLY_DELIVERY_QUEUE === undefined
    ? {}
    : { WEEKLY_DELIVERY_QUEUE: environment.WEEKLY_DELIVERY_QUEUE }),
  ...(environment.WEEKLY_DELIVERY_WORKFLOW === undefined
    ? {}
    : { WEEKLY_DELIVERY_WORKFLOW: environment.WEEKLY_DELIVERY_WORKFLOW }),
  ...(environment.WEEKLY_SUMMARY_ENABLED === undefined
    ? {}
    : { WEEKLY_SUMMARY_ENABLED: environment.WEEKLY_SUMMARY_ENABLED }),
  ...(environment.WEEKLY_SUMMARY_TEMPLATE_JSON === undefined
    ? {}
    : { WEEKLY_SUMMARY_TEMPLATE_JSON: environment.WEEKLY_SUMMARY_TEMPLATE_JSON }),
  ...(environment.WEEKLY_QUESTION_TEMPLATE_JSON === undefined
    ? {}
    : { WEEKLY_QUESTION_TEMPLATE_JSON: environment.WEEKLY_QUESTION_TEMPLATE_JSON }),
  ...(environment.PROACTIVITY_ASK_AFTER === undefined
    ? {}
    : { PROACTIVITY_ASK_AFTER: environment.PROACTIVITY_ASK_AFTER }),
  ...(environment.PROACTIVITY_PAUSE_AFTER === undefined
    ? {}
    : { PROACTIVITY_PAUSE_AFTER: environment.PROACTIVITY_PAUSE_AFTER }),
});

/** Normalize only the bindings needed by the published scheduled composition. */
const maintenanceInput = (environment: CoreEnvironment): CoreMaintenanceInput => ({
  DB: environment.DB,
  ...weeklyMaintenanceInput(environment),
  USER_TRANSACTION_COORDINATOR: environment.USER_TRANSACTION_COORDINATOR,
  AI: environment.AI,
  RELEASE_GIT_SHA: environment.RELEASE_GIT_SHA,
  KAPSO_API_KEY: environment.KAPSO_API_KEY,
  KAPSO_WEBHOOK_SECRET: environment.KAPSO_WEBHOOK_SECRET,
  HOSTED_AI_MODEL: environment.HOSTED_AI_MODEL,
  WOMPI_ENVIRONMENT: environment.WOMPI_ENVIRONMENT,
  WOMPI_PUBLIC_KEY: environment.WOMPI_PUBLIC_KEY,
  WOMPI_PRIVATE_KEY: environment.WOMPI_PRIVATE_KEY,
  WOMPI_INTEGRITY_SECRET: environment.WOMPI_INTEGRITY_SECRET,
  ASYNC_HEALTH_ENABLED: Option.fromUndefinedOr(environment.ASYNC_HEALTH_ENABLED),
  ASYNC_DEAD_LETTERS: Option.fromUndefinedOr(environment.ASYNC_DEAD_LETTERS),
  FORWARDED_EMAIL_QUEUE: Option.fromUndefinedOr(environment.FORWARDED_EMAIL_QUEUE),
  EMAIL_REPLACEMENT_HEALTH_QUEUE: Option.fromUndefinedOr(
    environment.EMAIL_REPLACEMENT_HEALTH_QUEUE
  ),
  OPERATIONAL_CANARY_QUEUE: Option.fromUndefinedOr(environment.OPERATIONAL_CANARY_QUEUE),
  OPERATIONAL_CANARY_WORKFLOW: Option.fromUndefinedOr(environment.OPERATIONAL_CANARY_WORKFLOW),
  EMAIL_BUCKET: Option.fromUndefinedOr(environment.EMAIL_BUCKET),
  STATEMENT_STAGING_BUCKET: Option.fromUndefinedOr(environment.STATEMENT_STAGING_BUCKET),
  ONBOARDING_EMAIL_QUEUE: Option.fromUndefinedOr(environment.ONBOARDING_EMAIL_QUEUE),
  BROWSER_PAIRING_EMAIL_QUEUE: Option.fromUndefinedOr(environment.BROWSER_PAIRING_EMAIL_QUEUE),
  EMAIL_REPLACEMENT_QUEUE: Option.fromUndefinedOr(environment.EMAIL_REPLACEMENT_QUEUE),
  BILLING_COLLECTION_QUEUE: Option.fromUndefinedOr(environment.BILLING_COLLECTION_QUEUE),
  STATEMENT_EXTRACTION_QUEUE: Option.fromUndefinedOr(environment.STATEMENT_EXTRACTION_QUEUE),
  HOSTED_WHATSAPP_QUEUE: Option.fromUndefinedOr(environment.HOSTED_WHATSAPP_QUEUE),
  ONBOARDING_EMAIL_WORKFLOW: Option.fromUndefinedOr(environment.ONBOARDING_EMAIL_WORKFLOW),
  BROWSER_PAIRING_EMAIL_WORKFLOW: Option.fromUndefinedOr(
    environment.BROWSER_PAIRING_EMAIL_WORKFLOW
  ),
  EMAIL_REPLACEMENT_WORKFLOW: Option.fromUndefinedOr(environment.EMAIL_REPLACEMENT_WORKFLOW),
  BILLING_COLLECTION_WORKFLOW: Option.fromUndefinedOr(environment.BILLING_COLLECTION_WORKFLOW),
  STATEMENT_EXTRACTION_WORKFLOW: Option.fromUndefinedOr(environment.STATEMENT_EXTRACTION_WORKFLOW),
  OPERATOR_ALERT_EMAIL: Option.fromUndefinedOr(environment.OPERATOR_ALERT_EMAIL),
  RESEND_API_KEY: Option.fromUndefinedOr(environment.RESEND_API_KEY),
  WOMPI_EVENT_SECRET: Option.fromUndefinedOr(environment.WOMPI_EVENT_SECRET),
  SMOKE_BUCKET: Option.fromUndefinedOr(environment.SMOKE_BUCKET),
  SMOKE_QUEUE: Option.fromUndefinedOr(environment.SMOKE_QUEUE),
  SMOKE_WORKFLOW: Option.fromUndefinedOr(environment.SMOKE_WORKFLOW),
  SMOKE_QUEUE_NAME: Option.fromUndefinedOr(environment.SMOKE_QUEUE_NAME),
  SMOKE_PROOF: Option.fromUndefinedOr(environment.SMOKE_PROOF),
  CF_VERSION_METADATA: Option.fromUndefinedOr(environment.CF_VERSION_METADATA),
});

/** Compose private HTTP, Queue and schedule entrypoints without acquiring owner implementation. */
export const makeCoreWorker = (telemetry: TelemetryService): CoreWorker => ({
  fetch: makeCoreHttp(telemetry),
  queue: makeCoreQueue(telemetry),
  scheduled: (_controller, environment) =>
    runCoreMaintenance(maintenanceInput(environment)).pipe(
      (work) =>
        observeWorkerExecution(work, {
          environment,
          telemetry,
          operation: "worker.core.scheduled",
        }),
      Effect.runPromise
    ),
});

/** Private service-binding target for canonical execution and bounded topology health evidence. */
export default makeCoreWorker(cloudflareWorkerTelemetry);
