import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect } from "effect";

export const nativeBuckets = Effect.all({
  STATEMENT_STAGING_BUCKET: Cloudflare.R2.Bucket("StatementStagingBucket", {
    name: "fidy-native-statement-staging",
  }),
  SAMPLE_BUCKET: Cloudflare.R2.Bucket("ApprovedIngestSamples", {
    name: "fidy-native-approved-ingest-samples",
  }),
  EMAIL_BUCKET: Cloudflare.R2.Bucket("ForwardedEmailBucket", {
    name: "fidy-native-forwarded-email",
  }),
});

const queue = Effect.fn(function* (id: string, slug: string) {
  return yield* Cloudflare.Queues.Queue(id, { name: "fidy-native-" + slug });
});

export const nativeQueues = Effect.all({
  ASYNC_DEAD_LETTERS: queue("AsyncDeadLetters", "async-dead-letters"),
  FORWARDED_EMAIL_QUEUE: queue("ForwardedEmailQueue", "forwarded-email"),
  CONNECTION_SYNCHRONIZATION_QUEUE: queue(
    "ConnectionSynchronizationQueue",
    "connection-synchronization"
  ),
  STATEMENT_EXTRACTION_QUEUE: queue("StatementExtractionQueue", "statement-extraction"),
  OPERATIONAL_CANARY_QUEUE: queue("OperationalCanaryQueue", "operational-canary"),
  BILLING_COLLECTION_QUEUE: queue("BillingCollectionQueue", "billing-collection"),
  HOSTED_WHATSAPP_QUEUE: queue("HostedWhatsAppQueue", "hosted-whatsapp"),
  WEEKLY_DELIVERY_QUEUE: queue("WeeklyDeliveryQueue", "weekly-delivery"),
  BROWSER_PAIRING_EMAIL_QUEUE: queue("BrowserPairingEmailQueue", "browser-pairing-email"),
});

export type NativeQueues = Effect.Success<typeof nativeQueues>;

export const nativeWorkflows = Effect.sync(() => ({
  CONNECTION_SYNCHRONIZATION_WORKFLOW: Cloudflare.Workflow("ConnectionSynchronizationWorkflow", {
    className: "ConnectionSynchronizationWorkflow",
    workflowName: "fidy-native-connection",
  }),
  STATEMENT_EXTRACTION_WORKFLOW: Cloudflare.Workflow("StatementExtractionWorkflowV1", {
    className: "StatementExtractionWorkflowV1",
    workflowName: "fidy-native-statement",
  }),
  OPERATIONAL_CANARY_WORKFLOW: Cloudflare.Workflow("OperationalCanaryWorkflowV1", {
    className: "OperationalCanaryWorkflowV1",
    workflowName: "fidy-native-canary",
  }),
  BILLING_COLLECTION_WORKFLOW: Cloudflare.Workflow("BillingCollectionWorkflowV1", {
    className: "BillingCollectionWorkflowV1",
    workflowName: "fidy-native-billing",
  }),
  BILLING_REFUND_WORKFLOW: Cloudflare.Workflow("BillingRefundWorkflowV1", {
    className: "BillingRefundWorkflowV1",
    workflowName: "fidy-native-refund",
  }),
  WEEKLY_DELIVERY_WORKFLOW: Cloudflare.Workflow("WeeklyDeliveryWorkflow", {
    className: "ProactivityDeliveryWorkflow",
    workflowName: "fidy-native-proactivity",
  }),
  BROWSER_PAIRING_EMAIL_WORKFLOW: Cloudflare.Workflow("BrowserPairingEmailWorkflowV1", {
    className: "BrowserPairingEmailWorkflowV1",
    workflowName: "fidy-native-login-email",
  }),
}));

const workBatchSize = 10;

export const installConsumers = Effect.fn(function* ({
  queues,
  core,
}: {
  queues: NativeQueues;
  core: Pick<Cloudflare.Worker, "workerName">;
}) {
  const consumers = [
    ["OperationalCanaryConsumer", queues.OPERATIONAL_CANARY_QUEUE, core, 1],
    ["ForwardedEmailConsumer", queues.FORWARDED_EMAIL_QUEUE, core, workBatchSize],
    [
      "ConnectionSynchronizationConsumer",
      queues.CONNECTION_SYNCHRONIZATION_QUEUE,
      core,
      workBatchSize,
    ],
    ["StatementExtractionConsumer", queues.STATEMENT_EXTRACTION_QUEUE, core, workBatchSize],
    ["BillingCollectionConsumer", queues.BILLING_COLLECTION_QUEUE, core, workBatchSize],
    ["BrowserPairingEmailConsumer", queues.BROWSER_PAIRING_EMAIL_QUEUE, core, workBatchSize],
    ["WeeklyDeliveryConsumer", queues.WEEKLY_DELIVERY_QUEUE, core, workBatchSize],
    ["HostedWhatsAppConsumer", queues.HOSTED_WHATSAPP_QUEUE, core, workBatchSize],
  ] as const;

  yield* Effect.forEach(
    consumers,
    Effect.fnUntraced(function* ([id, queue, worker, batchSize]) {
      yield* Cloudflare.Queues.Consumer(id, {
        queueId: queue.queueId,
        scriptName: worker.workerName,
        deadLetterQueue: queues.ASYNC_DEAD_LETTERS.queueName,
        settings: { batchSize, maxRetries: 3, maxWaitTimeMs: 0 },
      });
    }),
    { discard: true }
  );
});
