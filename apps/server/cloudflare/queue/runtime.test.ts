import { Clock, DateTime, Effect } from "effect";
import { afterAll, expect, it } from "vitest";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { makeWorkerTelemetry } from "../runtime/telemetry/operations";
import { makeCoreQueue } from "./runtime";
import type { CoreQueueEnvironment } from "./contract";

const unusedWorkflowOperation = (): Promise<never> =>
  Promise.reject(new Error("Unexpected Workflow operation"));
const workflowInstance: WorkflowInstance = {
  id: "canary",
  pause: unusedWorkflowOperation,
  resume: unusedWorkflowOperation,
  terminate: unusedWorkflowOperation,
  restart: unusedWorkflowOperation,
  delete: unusedWorkflowOperation,
  sendEvent: unusedWorkflowOperation,
  subscribe: unusedWorkflowOperation,
  status: () => Promise.resolve({ status: "complete" }),
};
const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());

it("inherits the Queue owner's Clock when validating a native canary handoff", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      const now = 100_000;
      const base = makeWorkerTelemetry(() => undefined);
      const queue = makeCoreQueue({
        ...base,
        observeWork: (observation, work) =>
          Clock.clockWith((clock) =>
            base.observeWork(observation, work).pipe(
              Effect.provideService(Clock.Clock, {
                currentTimeMillis: Effect.succeed(now),
                currentTimeMillisUnsafe: () => now,
                currentTimeNanos: Effect.succeed(BigInt(now) * 1_000_000n),
                currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
                monotonicTimeNanos: clock.monotonicTimeNanos,
                monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
                sleep: (duration) => clock.sleep(duration),
              })
            )
          ),
      });
      const created: unknown[] = [];
      const environment: CoreQueueEnvironment = {
        DB: db,
        RELEASE_GIT_SHA: "test",
        USER_TRANSACTION_COORDINATOR: {
          getByName: () => ({ fetch: () => Promise.resolve(new Response()) }),
        },
        OPERATIONAL_CANARY_QUEUE_NAME: "canary",
        OPERATIONAL_CANARY_WORKFLOW: {
          create: (input) => {
            created.push(input);
            return Promise.resolve(workflowInstance);
          },
          get: () => Promise.resolve(workflowInstance),
          createBatch: unusedWorkflowOperation,
          deleteBatch: unusedWorkflowOperation,
        },
      };
      yield* Effect.tryPromise(() =>
        queue(
          {
            queue: "canary",
            metadata: {
              metrics: {
                backlogCount: 1,
                backlogBytes: 1,
                oldestMessageTimestamp: DateTime.toDateUtc(DateTime.makeUnsafe(now)),
              },
            },
            ackAll: () => undefined,
            retryAll: () => undefined,
            messages: [
              {
                id: "canary-message",
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(now)),
                attempts: 1,
                ack: (): void => undefined,
                retry: (): void => undefined,
                body: { version: 1, sentAtMs: now },
              },
            ],
          },
          environment
        )
      );
      expect(created).toEqual([
        { id: "operational-canary-0", params: { version: 1, sentAtMs: now } },
      ]);
    })
  ));
