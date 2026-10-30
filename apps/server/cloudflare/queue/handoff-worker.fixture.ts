import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Clock, DateTime, Effect, Schema } from "effect";
import { makeCoreQueue } from "./runtime";
import { makeWorkerTelemetry } from "../runtime/telemetry/operations";

const batchSize = 8;
const retentionMilliseconds = 600_000;
const nanosecondsPerMillisecond = 1_000_000;
const Probe = Schema.Struct({
  ids: Schema.Array(Schema.String.check(Schema.isUUID(4))).check(
    Schema.isBetweenLength(batchSize, batchSize)
  ),
});
type Environment = Readonly<{ DB: D1Database; CHILD: Workflow }>;
const unavailable = (): Promise<never> => Promise.reject(new Error("Unexpected probe operation"));
const consume = makeCoreQueue(makeWorkerTelemetry(() => undefined));
const userId = "10000000-0000-4000-8000-000000000001";

const probeBatch = (
  ids: readonly string[],
  now: number
): Readonly<{
  batch: MessageBatch<unknown>;
  counts: () => Readonly<{ acknowledged: number; retries: number }>;
}> => {
  const acknowledged = new Set<string>();
  let retries = 0;
  const timestamp = DateTime.toDateUtc(DateTime.makeUnsafe(now));
  return {
    counts: () => ({ acknowledged: acknowledged.size, retries }),
    batch: {
      queue: "synthetic-statement-handoffs",
      metadata: {
        metrics: {
          backlogCount: ids.length,
          backlogBytes: ids.length,
          oldestMessageTimestamp: timestamp,
        },
      },
      ackAll: () => {
        throw new Error("Unexpected whole-batch acknowledgement");
      },
      retryAll: () => {
        retries += 1;
      },
      messages: ids.map((id) => ({
        id,
        timestamp,
        attempts: 1,
        body: { version: 1, userId, submissionId: id },
        ack: (): void => {
          acknowledged.add(id);
        },
        retry: (): void => {
          retries += 1;
        },
      })),
    },
  };
};

const measureHandoffs = Effect.fn(function* (environment: Environment, payload: unknown) {
  const { ids } = yield* Schema.decodeUnknownEffect(Probe)(payload);
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.tryPromise(() =>
    environment.DB.batch(
      ids.map((id) =>
        environment.DB.prepare("INSERT INTO statement_submissions VALUES (?,?,'queued',?)").bind(
          id,
          userId,
          now + retentionMilliseconds
        )
      )
    )
  );
  const { batch, counts } = probeBatch(ids, now);
  const started = yield* Clock.monotonicTimeNanos;
  yield* Effect.tryPromise(() =>
    consume(batch, {
      DB: environment.DB,
      RELEASE_GIT_SHA: "synthetic-handoff-proof",
      USER_TRANSACTION_COORDINATOR: { getByName: () => ({ fetch: unavailable }) },
      STATEMENT_EXTRACTION_WORKFLOW: environment.CHILD,
    })
  );
  const elapsed = (yield* Clock.monotonicTimeNanos) - started;
  return { elapsedMs: Number(elapsed) / nanosecondsPerMillisecond, ...counts() };
});

/** Hosted fixture has no public ingress, real extraction, email, or financial provider bindings. */
export class HandoffProbe extends WorkflowEntrypoint<Environment, unknown> {
  override run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<unknown> {
    return step.do(
      "measure-synthetic-handoff",
      { retries: { limit: 0, delay: 1 }, timeout: "30 seconds" },
      () => Effect.runPromise(measureHandoffs(this.env, event.payload))
    );
  }
}

/** Child proves native Workflow creation only; it cannot execute application extraction. */
export class HandoffChild extends WorkflowEntrypoint<Environment, unknown> {
  override run(): Promise<Readonly<{ synthetic: true }>> {
    return Promise.resolve({ synthetic: true });
  }
}
