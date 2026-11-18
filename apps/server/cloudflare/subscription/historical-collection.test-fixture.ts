import { Effect, Exit, Option, Schema } from "effect";
import {
  runBillingCollectionWorkflow as executeNative,
  receiveBillingCollection as receiveNative,
  wompiOutboundHttp,
} from "./runtime";
import { BillingAttemptId } from "../../src/core/subscription/contract";
import { collectBillingTransaction } from "./internal/billing-transaction";
import {
  cloudflareWorkerTelemetry,
  observeWorkerExecution,
  sanitizeWorkTrace,
  workTraceParent,
  workerRelease,
} from "../runtime/telemetry/operations";
import { BillingCollectionFailure } from "./contract";

const attempt = <Value>(
  run: () => Promise<Value>
): Effect.Effect<Value, BillingCollectionFailure> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BillingCollectionFailure({ cause: Option.some(cause) }),
  });
const CollectionMessage = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
  version: Schema.Literal(1),
  attemptId: BillingAttemptId,
});
const workflowRetention = { successRetention: "3 days", errorRetention: "3 days" } as const;
const ArmState = Schema.Struct({ state: Schema.Literals(["armed", "sent", "rejected"]) });

/** Exercise older enrollment and renewal producers in isolation while their retained effects move in #2248. */
export const runBillingCollectionWorkflow: typeof executeNative = (input) => {
  const work = Schema.decodeUnknownOption(CollectionMessage)(input.payload);
  if (Option.isNone(work)) return executeNative(input);
  const options = { retries: { limit: 0, delay: "1 second" } } as const;
  const runActivity = <E>(activity: Effect.Effect<void, E>): Promise<void> =>
    activity.pipe(
      observeWorkerExecution({
        environment: workerRelease(input.environment),
        telemetry: cloudflareWorkerTelemetry,
        operation: "workflow.billingCollection",
        parent: workTraceParent(input.payload),
      }),
      Effect.runPromise
    );
  const attemptId = work.value.attemptId;
  return input.activity("collect-wompi-billing-v1", options, () =>
    runActivity(
      collectBillingTransaction({
        environment: input.environment,
        attemptId,
        wompiHttp: wompiOutboundHttp,
      })
    )
  );
};

export const receiveBillingCollection: typeof receiveNative = (input) =>
  Effect.gen(function* () {
    for (const message of input.batch.messages) {
      const work = Schema.decodeUnknownOption(CollectionMessage)(message.body);
      if (Option.isNone(work)) {
        yield* receiveNative({ ...input, batch: { messages: [message] } });
        continue;
      }
      const collection = work.value;
      const row = yield* attempt(() =>
        input.environment.DB.prepare(
          "SELECT state FROM (SELECT rowid,id AS attempt_id,collection_state AS state,collection_sent_at_ms AS sent_at_ms,collection_last_attempt_at_ms AS last_attempt_at_ms FROM billing_attempt_context WHERE collection_state IS NOT NULL) AS billing_collection_work WHERE attempt_id = ?"
        )
          .bind(collection.attemptId)
          .first()
      );
      const arm = Schema.decodeUnknownOption(ArmState)(row);
      if (Option.isNone(arm) || arm.value.state !== "armed") {
        message.ack();
        continue;
      }
      const params = yield* sanitizeWorkTrace(collection);
      const started = yield* Effect.exit(
        attempt(() =>
          input.environment.BILLING_COLLECTION_WORKFLOW.create({
            id: collection.attemptId,
            params,
            retention: workflowRetention,
          })
        )
      );
      if (Exit.isFailure(started)) {
        yield* attempt(() =>
          input.environment.BILLING_COLLECTION_WORKFLOW.get(collection.attemptId)
        );
      }
      message.ack();
    }
  });
