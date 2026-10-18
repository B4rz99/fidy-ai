import { withErasureRecovery } from "./erasure/runtime";
import { Option } from "effect";
import type { CoreMaintenanceInput } from "./maintenance/contract";

const releaseShaLength = 40;

/** Complete configured maintenance capabilities; external effects stay at synthetic test seams. */
export const maintenancePerformanceEnvironment = ({
  db,
  bucket,
  queue,
  workflow,
}: Readonly<{
  db: D1Database;
  bucket: R2Bucket;
  queue: Queue;
  workflow: Workflow;
}>): CoreMaintenanceInput => ({
  DB: db,
  USER_TRANSACTION_COORDINATOR: {
    getByName: () => ({
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    }),
  },
  AI: { run: () => Promise.reject(new Error("Idle maintenance must not infer")) },
  WEEKLY_DELIVERY_QUEUE: queue,
  WEEKLY_DELIVERY_WORKFLOW: workflow,
  WEEKLY_SUMMARY_ENABLED: "disabled",
  RELEASE_GIT_SHA: "a".repeat(releaseShaLength),
  HOSTED_AI_MODEL: "configured",
  KAPSO_API_KEY: "configured",
  KAPSO_WEBHOOK_SECRET: "configured",
  WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "configured",
  WOMPI_PRIVATE_KEY: "configured",
  WOMPI_INTEGRITY_SECRET: "configured",
  ASYNC_HEALTH_ENABLED: Option.some("enabled"),
  ASYNC_DEAD_LETTERS: Option.some(queue),
  FORWARDED_EMAIL_QUEUE: Option.some(queue),
  EMAIL_REPLACEMENT_HEALTH_QUEUE: Option.some(queue),
  OPERATIONAL_CANARY_QUEUE: Option.some(queue),
  OPERATIONAL_CANARY_WORKFLOW: Option.some(workflow),
  EMAIL_BUCKET: Option.some(bucket),
  STATEMENT_STAGING_BUCKET: Option.some(bucket),
  BROWSER_PAIRING_EMAIL_QUEUE: Option.some(queue),
  EMAIL_REPLACEMENT_QUEUE: Option.some(queue),
  BILLING_COLLECTION_QUEUE: Option.some(queue),
  STATEMENT_EXTRACTION_QUEUE: Option.some(queue),
  HOSTED_WHATSAPP_QUEUE: Option.some(queue),
  BROWSER_PAIRING_EMAIL_WORKFLOW: Option.some(workflow),
  EMAIL_REPLACEMENT_WORKFLOW: Option.some(workflow),
  BILLING_COLLECTION_WORKFLOW: Option.some(workflow),
  STATEMENT_EXTRACTION_WORKFLOW: Option.some(workflow),
  OPERATOR_ALERT_EMAIL: Option.some("performance@example.invalid"),
  RESEND_API_KEY: Option.some("configured"),
  WOMPI_EVENT_SECRET: Option.some("configured"),
  SMOKE_BUCKET: Option.some(bucket),
  SMOKE_QUEUE: Option.some(queue),
  SMOKE_WORKFLOW: Option.some(workflow),
  SMOKE_QUEUE_NAME: Option.some("fixture"),
  SMOKE_PROOF: Option.some("fixture"),
  CF_VERSION_METADATA: Option.some({ id: "fixture" }),
});

/** Production recovery policy for the complete native maintenance composition. */
export const maintenancePerformanceDatabase = ({
  db,
  bucket,
}: Readonly<{ db: D1Database; bucket: R2Bucket }>): D1Database =>
  withErasureRecovery({ DB: db, ERASURE_REQUIRED: "true", ERASURE_BUCKET: bucket }).DB;
