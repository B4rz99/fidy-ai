import { Data, type Effect, type Option } from "effect";
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
  ONBOARDING_EMAIL_QUEUE: Option.Option<Pick<Queue, "metrics">>;
  BROWSER_PAIRING_EMAIL_QUEUE: Option.Option<Pick<Queue, "metrics">>;
  EMAIL_REPLACEMENT_QUEUE: Option.Option<Queue>;
  BILLING_COLLECTION_QUEUE: Option.Option<Pick<Queue, "metrics">>;
  STATEMENT_EXTRACTION_QUEUE: Option.Option<Pick<Queue, "metrics">>;
  HOSTED_WHATSAPP_QUEUE: Option.Option<Pick<Queue, "metrics">>;
  ONBOARDING_EMAIL_WORKFLOW: Option.Option<Workflow>;
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
}>;

/** Fixed-policy platform maintenance; actions are independent. Decision instants are Unix epoch milliseconds. */
export type PlatformMaintenance = Readonly<{
  inspectHealth: () => Effect.Effect<void, PlatformMaintenanceUnavailable>;
  retainEventBuckets: (nowEpochMs: number) => Effect.Effect<void, PlatformMaintenanceUnavailable>;
  publishCanary: (nowEpochMs: number) => Effect.Effect<void, PlatformMaintenanceUnavailable>;
  expireSmokeProbes: (nowEpochMs: number) => Effect.Effect<void, PlatformMaintenanceUnavailable>;
}>;
