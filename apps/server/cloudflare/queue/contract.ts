import type { ProactivityDeliveryWork } from "../insights/contract";

/** Queue composition receives only native handoff bindings. */
import type { BillingWorkRouting } from "../subscription/contract";

export type CoreQueueEnvironment = BillingWorkRouting &
  Readonly<{
    DB: D1Database;
    RELEASE_GIT_SHA: string;
    USER_TRANSACTION_COORDINATOR: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
  }> &
  Partial<
    Readonly<{
      EMAIL_BUCKET: R2Bucket;
      RESEND_API_KEY: string;
      BROWSER_PAIRING_EMAIL_WORKFLOW: Workflow;
      EMAIL_REPLACEMENT_WORKFLOW: Workflow;
      BILLING_COLLECTION_WORKFLOW: Workflow;
      BILLING_REFUND_WORKFLOW: Workflow;
      STATEMENT_EXTRACTION_WORKFLOW: Workflow;
      WEEKLY_DELIVERY_WORKFLOW: Workflow<ProactivityDeliveryWork>;
      OPERATIONAL_CANARY_QUEUE_NAME: string;
      OPERATIONAL_CANARY_WORKFLOW: Workflow;
    }>
  >;

/** Native redelivery preserves owner validation and acknowledgment; handoff is not completion. */
export type CoreQueueHandler = (
  batch: MessageBatch<unknown>,
  environment: CoreQueueEnvironment
) => Promise<void>;
