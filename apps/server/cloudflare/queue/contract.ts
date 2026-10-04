import type { SmokeBindings } from "../runtime/release-smoke/contract";

/** Queue composition receives only native handoff bindings and the existing smoke readiness inputs. */
export type CoreQueueEnvironment = Readonly<{
  DB: D1Database;
  RELEASE_GIT_SHA: string;
  USER_TRANSACTION_COORDINATOR: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
}> &
  Partial<SmokeBindings> &
  Partial<
    Readonly<{
      EMAIL_BUCKET: R2Bucket;
      RESEND_API_KEY: string;
      ONBOARDING_EMAIL_QUEUE: Queue;
      ONBOARDING_EMAIL_WORKFLOW: Workflow;
      BROWSER_PAIRING_EMAIL_WORKFLOW: Workflow;
      EMAIL_REPLACEMENT_WORKFLOW: Workflow;
      BILLING_COLLECTION_WORKFLOW: Workflow;
      BILLING_REFUND_WORKFLOW: Workflow;
      STATEMENT_EXTRACTION_WORKFLOW: Workflow;
      OPERATIONAL_CANARY_QUEUE_NAME: string;
      OPERATIONAL_CANARY_WORKFLOW: Workflow;
    }>
  >;

/** Native redelivery preserves owner validation and acknowledgment; handoff is not completion. */
export type CoreQueueHandler = (
  batch: MessageBatch<unknown>,
  environment: CoreQueueEnvironment
) => Promise<void>;
