import { installedOrigins } from "@fidy/server/browser-transport";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import { freeTierWorkerObservability } from "./worker-observability";
import { type NativeRelease, bindPlannedText } from "./native-application-bindings";
import { accountingFixture, nativeSmokeMain } from "./native-fixture-signer";

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
  SMOKE_BUCKET: Cloudflare.R2.Bucket("ReleaseSmokeBucket", {
    name: "fidy-native-release-smoke",
    lifecycleRules: [
      {
        id: "expire-verified-probes",
        prefix: "_release-smoke/",
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } },
      },
    ],
  }),
});

const queue = Effect.fn(function* (id: string, slug: string) {
  return yield* Cloudflare.Queues.Queue(id, { name: "fidy-native-" + slug });
});

export const nativeQueues = Effect.fn(function* (revision: string) {
  return yield* Effect.all({
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
    SMOKE_QUEUE: queue("ReleaseSmokeQueue-" + revision, "smoke-" + revision),
  });
});

export type NativeQueues = Effect.Success<ReturnType<typeof nativeQueues>>;

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

const smokeIdentity = (
  release: NativeRelease
): Pick<NativeRelease["shared"], "RELEASE_GIT_SHA" | "CONTRACT_DIGEST"> =>
  release.accountingRollout || release.signupOpening
    ? {
        RELEASE_GIT_SHA: accountingFixture.revision,
        CONTRACT_DIGEST: accountingFixture.contractDigest,
      }
    : {
        RELEASE_GIT_SHA: release.release.gitRevision,
        CONTRACT_DIGEST: release.release.contractDigest,
      };

export const nativeSmokeExecutor = Effect.fn(function* (input: {
  release: NativeRelease;
  queues: NativeQueues;
  buckets: Effect.Success<typeof nativeBuckets>;
}) {
  const revision = input.release.resourceRevision,
    workflowName = "fidy-native-smoke-" + revision;

  const smoke = yield* Cloudflare.Worker("ReleaseSmoke-" + revision, {
    name: "fidy-native-smoke-" + revision,
    main: nativeSmokeMain,
    compatibility: { date: "2026-09-08" },
    workersDev: false,
    observability: freeTierWorkerObservability,
    env: {
      SMOKE_BUCKET: input.buckets.SMOKE_BUCKET,
      NATIVE_STORAGE_ADMISSION: input.release.signupOpening
        ? "closed"
        : input.release.shared.NATIVE_STORAGE_ADMISSION,
      ACCEPTANCE_API_ORIGIN: input.release.signupOpening
        ? installedOrigins.acceptance.api
        : input.release.origin.api,
      ACCEPTANCE_CODE_KEY: input.release.fixtureSecret("oidc-code", "", revision),
      ACCEPTANCE_GOOGLE_SECRET: input.release.fixtureSecret("google", "", revision),
      ACCEPTANCE_MICROSOFT_SECRET: input.release.fixtureSecret("microsoft", "", revision),
      SMOKE_WORKFLOW: Cloudflare.Workflow("ReleaseSmokeWorkflowV2-" + revision, {
        workflowName,
        className: "ReleaseSmokeWorkflowV2",
      }),
      CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
      ...smokeIdentity(input.release),
    },
  });

  yield* bindPlannedText(smoke, { SMOKE_QUEUE_NAME: input.queues.SMOKE_QUEUE.queueName });

  return {
    smoke,
    reference: Cloudflare.Workflow("ReleaseSmokeReference", {
      workflowName,
      className: "ReleaseSmokeWorkflowV2",
      scriptName: input.release.signupOpening ? workflowName : smoke.workerName,
    }),
  };
});

const workBatchSize = 10;

export const installConsumers = Effect.fn(function* ({
  queues,
  revision,
  core,
  smoke,
}: {
  queues: NativeQueues;
  revision: string;
  core: Pick<Cloudflare.Worker, "workerName">;
  smoke: Pick<Cloudflare.Worker, "workerName">;
}) {
  const consumers = [
    ["OperationalCanaryConsumer", queues.OPERATIONAL_CANARY_QUEUE, core, 1],
    ["ReleaseSmokeConsumer-" + revision, queues.SMOKE_QUEUE, smoke, 1],
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
