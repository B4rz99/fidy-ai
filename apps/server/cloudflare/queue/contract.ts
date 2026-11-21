import type { Effect } from "effect";
import type { ExternalEventBindings } from "../directory/contract";
import type { ProactivityDeliveryWork } from "../insights/contract";

import type { BillingWorkRouting } from "../subscription/contract";

export type CoreQueueEnvironment = BillingWorkRouting &
  Partial<ExternalEventBindings> &
  Readonly<{
    RELEASE_GIT_SHA: string;
  }> &
  Partial<
    Readonly<{
      CONNECTION_SYNCHRONIZATION_WORKFLOW: Workflow;
      CONNECTION_SYNCHRONIZATION_QUEUE_NAME: string;
      EMAIL_BUCKET: R2Bucket;
      RESEND_API_KEY: string;
      BROWSER_PAIRING_EMAIL_WORKFLOW: Workflow;
      BILLING_COLLECTION_WORKFLOW: Workflow;
      BILLING_REFUND_WORKFLOW: Workflow;
      STATEMENT_EXTRACTION_WORKFLOW: Workflow;
      WEEKLY_DELIVERY_WORKFLOW: Workflow<ProactivityDeliveryWork>;
      OPERATIONAL_CANARY_QUEUE_NAME: string;
      OPERATIONAL_CANARY_WORKFLOW: Workflow;
    }>
  >;

export type CoreQueueHandler = (
  batch: MessageBatch<unknown>,
  environment: CoreQueueEnvironment
) => Effect.Effect<void>;
