import { Data, type Effect, type Option } from "effect";
import type { ProactivityEnvironment } from "../insights/contract";
import type { WorkersAiEnvironment } from "../ai/contract";

/** Platform-owned scheduled work exposes completion only, never diagnostic or provider details. */
export class PlatformMaintenanceUnavailable extends Data.TaggedError(
  "PlatformMaintenanceUnavailable"
) {}

/** Worker bindings and configuration; absent optional capabilities stay explicit at construction. */
export type PlatformMaintenanceInput = Readonly<{
  DB: D1Database;
  USER_TRANSACTION_COORDINATOR: Readonly<{
    getByName: (name: string) => Pick<Fetcher, "fetch">;
  }>;
  AI: WorkersAiEnvironment["AI"];
  RELEASE_GIT_SHA: string;
  KAPSO_API_KEY: string;
  KAPSO_WEBHOOK_SECRET: string;
  WHATSAPP_SANDBOX_PHONE_NUMBER_ID: string;
  HOSTED_AI_MODEL: string;
  WOMPI_ENVIRONMENT: string;
  WOMPI_PUBLIC_KEY: string;
  WOMPI_PRIVATE_KEY: string;
  WOMPI_INTEGRITY_SECRET: string;
  ASYNC_HEALTH_ENABLED: Option.Option<"enabled">;
  ASYNC_DEAD_LETTERS: Option.Option<Pick<Queue, "metrics">>;
  FORWARDED_EMAIL_QUEUE: Option.Option<Pick<Queue, "metrics">>;
  EMAIL_REPLACEMENT_HEALTH_QUEUE: Option.Option<Pick<Queue, "metrics">>;
  OPERATIONAL_CANARY_QUEUE: Option.Option<Pick<Queue, "send">>;
  OPERATIONAL_CANARY_WORKFLOW: Option.Option<Workflow>;
  EMAIL_BUCKET: Option.Option<R2Bucket>;
  STATEMENT_STAGING_BUCKET: Option.Option<R2Bucket>;
  BROWSER_PAIRING_EMAIL_QUEUE: Option.Option<Pick<Queue, "metrics">>;
  EMAIL_REPLACEMENT_QUEUE: Option.Option<Queue>;
  BILLING_COLLECTION_QUEUE: Option.Option<Pick<Queue, "metrics">>;
  STATEMENT_EXTRACTION_QUEUE: Option.Option<Pick<Queue, "metrics">>;
  HOSTED_WHATSAPP_QUEUE: Option.Option<Pick<Queue, "metrics">>;
  BROWSER_PAIRING_EMAIL_WORKFLOW: Option.Option<Workflow>;
  EMAIL_REPLACEMENT_WORKFLOW: Option.Option<Workflow>;
  BILLING_COLLECTION_WORKFLOW: Option.Option<Workflow>;
  STATEMENT_EXTRACTION_WORKFLOW: Option.Option<Workflow>;
  OPERATOR_ALERT_EMAIL: Option.Option<string>;
  RESEND_API_KEY: Option.Option<string>;
  WOMPI_EVENT_SECRET: Option.Option<string>;
  SMOKE_BUCKET: Option.Option<R2Bucket>;
  SMOKE_QUEUE: Option.Option<Queue>;
  SMOKE_WORKFLOW: Option.Option<Workflow>;
  SMOKE_QUEUE_NAME: Option.Option<string>;
  SMOKE_PROOF: Option.Option<string>;
  CF_VERSION_METADATA: Option.Option<Readonly<{ id: string }>>;
}> &
  Pick<ProactivityEnvironment, "WEEKLY_SUMMARY_ENABLED" | "PROACTIVITY_ENABLED"> &
  Partial<
    Readonly<{
      WEEKLY_DELIVERY_QUEUE: Pick<Queue, "metrics">;
      WEEKLY_DELIVERY_WORKFLOW: Workflow;
    }>
  >;

/** Fixed-policy platform maintenance; actions are independent. Decision instants are Unix epoch milliseconds. */
export type PlatformMaintenance = Readonly<{
  inspectHealth: () => Effect.Effect<void, PlatformMaintenanceUnavailable>;
  retainEventBuckets: (nowEpochMs: number) => Effect.Effect<void, PlatformMaintenanceUnavailable>;
  publishCanary: (nowEpochMs: number) => Effect.Effect<void, PlatformMaintenanceUnavailable>;
  expireSmokeProbes: (nowEpochMs: number) => Effect.Effect<void, PlatformMaintenanceUnavailable>;
}>;

/** Non-secret PAT fixture accepted only by the local canonical-operation harness. */
export const localCanonicalReadBearer = "fin_localdev_local-emulation-category-read-token";

/** Stable production network surface consumed by the Alchemy stack and topology tests. */
export const productionTopology = {
  core: {
    d1Binding: "DB",
    localPort: 8788,
    workersDev: false,
  },
  ingress: {
    coreBinding: "CORE",
    hostname: "api.fidyapp.com",
    localPort: 8787,
    workersDev: false,
  },
  web: {
    adoptExistingWorker: true,
    hostname: "app.fidyapp.com",
    localPort: 5173,
    redirects: ["fidyapp.com"],
    workerName: "fidy-web",
    workersDev: false,
  },
} as const;

/** Closed browser origins accepted by the public Worker in each complete topology mode. */
export const browserOrigins = {
  local: `http://127.0.0.1:${productionTopology.web.localPort}`,
  acceptance: "https://127.0.0.1:4173",
  production: `https://${productionTopology.web.hostname}`,
} as const;

/** Canonical lowercase release-identity formats shared by deployment and Worker boundaries. */
export const gitRevisionPattern = /^[0-9a-f]{40}$/u;
export const contractDigestPattern = /^[0-9a-f]{64}$/u;
