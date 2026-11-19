import { Effect, Schema } from "effect";
import {
  type NativeBinding,
  NativeBindings,
  type NativeRole,
  requireRoleBindings,
} from "./native-graph";
import { verifiedVersionResources } from "./rollback-compatibility";
import { installationNames, nativeStack } from "./storage-installation";

import { type ProviderRead as Read, readProviderList as pages } from "./native-provider-list";

const identifier = Schema.NonEmptyString;
const named = Schema.Struct({ name: identifier });
const prefix = "fidy-native-";
const bucketTargets = {
  STATEMENT_STAGING_BUCKET: "statement-staging",
  SAMPLE_BUCKET: "approved-ingest-samples",
  EMAIL_BUCKET: "forwarded-email",
  SMOKE_BUCKET: "release-smoke",
} as const;
const queueTargets = (revision: string): Readonly<Record<string, string>> => ({
  ASYNC_DEAD_LETTERS: "async-dead-letters",
  FORWARDED_EMAIL_QUEUE: "forwarded-email",
  CONNECTION_SYNCHRONIZATION_QUEUE: "connection-synchronization",
  STATEMENT_EXTRACTION_QUEUE: "statement-extraction",
  OPERATIONAL_CANARY_QUEUE: "operational-canary",
  BILLING_COLLECTION_QUEUE: "billing-collection",
  HOSTED_WHATSAPP_QUEUE: "hosted-whatsapp",
  WEEKLY_DELIVERY_QUEUE: "weekly-delivery",
  BROWSER_PAIRING_EMAIL_QUEUE: "browser-pairing-email",
  SMOKE_QUEUE: "smoke-" + revision,
});
const workflowTargets = (
  revision: string
): Readonly<Record<string, readonly [string, string]>> => ({
  CONNECTION_SYNCHRONIZATION_WORKFLOW: ["connection", "ConnectionSynchronizationWorkflow"],
  STATEMENT_EXTRACTION_WORKFLOW: ["statement", "StatementExtractionWorkflowV1"],
  OPERATIONAL_CANARY_WORKFLOW: ["canary", "OperationalCanaryWorkflowV1"],
  BILLING_COLLECTION_WORKFLOW: ["billing", "BillingCollectionWorkflowV1"],
  BILLING_REFUND_WORKFLOW: ["refund", "BillingRefundWorkflowV1"],
  WEEKLY_DELIVERY_WORKFLOW: ["proactivity", "ProactivityDeliveryWorkflow"],
  BROWSER_PAIRING_EMAIL_WORKFLOW: ["login-email", "BrowserPairingEmailWorkflowV1"],
  SMOKE_WORKFLOW: ["smoke-" + revision, "ReleaseSmokeWorkflowV2"],
});
const smokeName = (revision: string): string => prefix + "smoke-" + revision;
const requireTarget = (valid: boolean, name: string): void => {
  if (!valid) throw Error("Unexpected deployed target for " + name);
};
const requireWorkflowBinding = (
  binding: NativeBinding,
  role: NativeRole,
  revision: string
): void => {
  const target = workflowTargets(revision)[binding.name],
    smoke = smokeName(revision);
  const worker = binding.name === "SMOKE_WORKFLOW" ? smoke : installationNames.Core;
  const host = role === "Smoke" ? smoke : installationNames.Core;
  requireTarget(
    target !== undefined &&
      binding.workflow_name === prefix + target[0] &&
      binding.class_name === target[1] &&
      (binding.script_name ?? host) === worker,
    binding.name
  );
};
const bucketFor = (name: string): string => {
  const target = Object.entries(bucketTargets).find(([key]) => key === name);
  if (target === undefined) throw Error("Unrecognized deployed bucket " + name);
  return target[1];
};
const requireService = (binding: NativeBinding, revision: string): void => {
  const worker = binding.name === "CORE" ? installationNames.Core : smokeName(revision);
  requireTarget(binding.service === worker && binding.entrypoint === undefined, binding.name);
};
const requireQueueName = (
  binding: NativeBinding,
  queues: ReturnType<typeof queueTargets>
): void => {
  if (binding.type === "plain_text" && binding.name.endsWith("_QUEUE_NAME")) {
    requireTarget(
      binding.text === prefix + queues[binding.name.slice(0, -"_NAME".length)],
      binding.name
    );
  }
};
/** Assert actual provider metadata for each consuming Worker, including its independently deployed private service targets. */
export const requireDeployedRole = (input: {
  role: Exclude<NativeRole, "Web">;
  revision: string;
  bindings: Readonly<Record<string, unknown>>;
  fingerprint: string;
}): void => {
  const { role, revision } = input,
    bindings = Schema.decodeUnknownSync(NativeBindings)(Object.values(input.bindings));
  requireRoleBindings({ role, bindings, fingerprint: input.fingerprint });
  const queues = queueTargets(revision);
  for (const binding of bindings) {
    if (binding.type === "r2_bucket") {
      requireTarget(binding.bucket_name === prefix + bucketFor(binding.name), binding.name);
    }
    if (binding.type === "queue") {
      requireTarget(binding.queue_name === prefix + queues[binding.name], binding.name);
    }
    if (binding.type === "workflow") requireWorkflowBinding(binding, role, revision);
    if (binding.type === "service") requireService(binding, revision);
    requireQueueName(binding, queues);
  }
};
const noHandlers = Schema.Tuple([]);
const staticSiteVersion = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    id: Schema.NonEmptyString,
    resources: Schema.Struct({
      bindings: Schema.Tuple([]),
      script: Schema.Struct({
        handlers: Schema.NullOr(noHandlers),
        named_handlers: Schema.optionalKey(noHandlers),
      }),
      script_runtime: Schema.Struct({
        compatibility_date: Schema.NonEmptyString,
        assets: Schema.Struct({
          serve_directly: Schema.Literal(true),
          raw_run_worker_first: Schema.Literal(false),
          html_handling: Schema.Literal("none"),
          not_found_handling: Schema.Literal("single-page-application"),
          base_path: Schema.Literal("/"),
        }),
      }),
    }),
  }),
});
/** StaticSite gets revision and contract evidence from the independently rebuilt and served assets. */
export const verifyDeployedVersion = (input: {
  role: NativeRole;
  raw: unknown;
  account: string;
  versionId: string;
  revision: string;
  fingerprint: string;
}): void => {
  if (input.role === "Web") {
    const { result } = Schema.decodeUnknownSync(staticSiteVersion)(input.raw);
    requireTarget(result.id === input.versionId, "Web");
    return;
  }
  const bindings = { ...verifiedVersionResources(input).bindings };
  const { role, revision } = input;
  // WorkerProvider adds these coordinates when uploading executable scripts, after the plan binding check.
  const runtime = {
    ALCHEMY_PHASE: "runtime",
    ALCHEMY_WORKER_NAME: role === "Smoke" ? smokeName(revision) : installationNames[role],
    ALCHEMY_STACK_NAME: nativeStack,
    ALCHEMY_STAGE: "production",
    ALCHEMY_CLOUDFLARE_ACCOUNT_ID: input.account,
  };
  for (const [name, text] of Object.entries(runtime)) {
    const coordinate = Schema.Struct({
      name: Schema.Literal(name),
      type: Schema.Literal("plain_text"),
      text: Schema.Literal(text),
    });
    requireTarget(Schema.is(coordinate)(bindings[name]), name);
    delete bindings[name];
  }
  requireDeployedRole({ role, revision, bindings, fingerprint: input.fingerprint });
};
const limit = 100;
const buckets = Effect.fn(function* (read: Read) {
  const result: string[] = [],
    seen = new Set<string>();
  let cursor = "";
  const shape = Schema.Struct({
    success: Schema.Literal(true),
    result: Schema.Struct({ buckets: Schema.Array(named) }),
    result_info: Schema.Struct({ cursor: Schema.optional(Schema.NullOr(Schema.String)) }),
  });
  for (let page = 0; page < limit; page++) {
    const query = new URLSearchParams({ name_contains: prefix, per_page: String(limit) });
    if (cursor.length > 0) query.set("cursor", cursor);
    const body = yield* Schema.decodeUnknownEffect(shape)(yield* read("r2/buckets?" + query));
    result.push(...body.result.buckets.map((bucket) => bucket.name));
    cursor = body.result_info.cursor ?? "";
    if (cursor.length === 0) return result;
    if (seen.has(cursor)) return yield* Effect.fail(Error("Repeated R2 inventory page"));
    seen.add(cursor);
  }
  return yield* Effect.fail(Error("R2 inventory exceeds release budget"));
});
const Queue = Schema.Struct({ queue_name: identifier, queue_id: identifier });
const Workflow = Schema.Struct({
  name: identifier,
  id: identifier,
  script_name: identifier,
  class_name: identifier,
});
const consumer = Schema.Struct({
  consumer_id: identifier,
  script: Schema.optionalKey(identifier),
  script_name: Schema.optionalKey(identifier),
  dead_letter_queue: identifier,
  type: Schema.Literal("worker"),
  settings: Schema.Struct({
    batch_size: Schema.Int,
    max_retries: Schema.Int,
    max_wait_time_ms: Schema.Int,
  }),
}).check(
  Schema.makeFilter(
    (row) =>
      row.script === undefined || row.script_name === undefined || row.script === row.script_name
  )
);
const inspectConsumers = Effect.fn(function* (
  read: Read,
  installed: typeof Queue.Type,
  revision: string
) {
  const { result } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ success: Schema.Literal(true), result: Schema.Array(Schema.Unknown) })
  )(yield* read("queues/" + installed.queue_id + "/consumers"));
  const dlq = prefix + "async-dead-letters",
    smoke = smokeName(revision);
  if (installed.queue_name === dlq) {
    if (result.length !== 0) {
      return yield* Effect.fail(Error("Native dead-letter queue has a consumer"));
    }
    return [];
  }
  const [row] = yield* Schema.decodeUnknownEffect(Schema.Tuple([consumer]))(result);
  const workBatchSize = 10;
  const expectedSize = [smoke, prefix + "operational-canary"].includes(installed.queue_name)
    ? 1
    : workBatchSize;
  yield* Effect.try(() =>
    requireTarget(
      (row.script ?? row.script_name) ===
        (installed.queue_name === smoke ? smoke : installationNames.Core) &&
        row.dead_letter_queue === dlq &&
        row.settings.batch_size === expectedSize &&
        row.settings.max_retries === 3 &&
        row.settings.max_wait_time_ms === 0,
      installed.queue_name
    )
  );
  return [row.consumer_id];
});
/** Read all candidate-owned data resources before the first mutation and verify their exact consumer ownership after installation. */
export const inspectNativeResources = Effect.fn(function* (
  read: Read,
  revision: string,
  installed: boolean
) {
  const wantedBuckets = Object.values(bucketTargets).map((slug) => prefix + slug),
    wantedQueues = Object.values(queueTargets(revision)).map((slug) => prefix + slug),
    wantedWorkflows = Object.values(workflowTargets(revision));
  const presentBuckets = (yield* buckets(read)).filter((item) => wantedBuckets.includes(item)),
    presentQueues = (yield* pages(read, "queues", Queue)).filter((item) =>
      wantedQueues.includes(item.queue_name)
    ),
    presentWorkflows = (yield* pages(read, "workflows", Workflow)).filter((item) =>
      wantedWorkflows.some(([slug]) => prefix + slug === item.name)
    );
  if (!installed) {
    if (presentBuckets.length + presentQueues.length + presentWorkflows.length > 0) {
      return yield* Effect.fail(Error("Native Queue, bucket or Workflow already exists"));
    }
    return { buckets: [], queues: [], workflows: [] };
  }
  const same = (rows: readonly string[], wanted: readonly string[]): boolean =>
    rows.length === wanted.length && wanted.every((item) => rows.includes(item));
  if (
    !same(presentBuckets, wantedBuckets) ||
    !same(
      presentQueues.map((item) => item.queue_name),
      wantedQueues
    ) ||
    !same(
      presentWorkflows.map((item) => item.name),
      wantedWorkflows.map(([slug]) => prefix + slug)
    )
  ) {
    return yield* Effect.fail(Error("Missing deployed data resource"));
  }
  for (const item of presentWorkflows) {
    const target = wantedWorkflows.find(([slug]) => item.name === prefix + slug);
    yield* Effect.try(() =>
      requireTarget(
        target !== undefined &&
          item.class_name === target[1] &&
          item.script_name ===
            (item.name === smokeName(revision) ? item.name : installationNames.Core),
        item.name
      )
    );
  }
  const queues = yield* Effect.forEach(
    presentQueues,
    Effect.fn(function* (item) {
      return { ...item, consumers: yield* inspectConsumers(read, item, revision) };
    }),
    { concurrency: 3 }
  );
  return { buckets: presentBuckets, queues, workflows: presentWorkflows };
});
