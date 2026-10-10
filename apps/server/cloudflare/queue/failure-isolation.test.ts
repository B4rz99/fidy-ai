import { afterAll, expect, it } from "vitest";
import { type Cause, Clock, DateTime, Deferred, Effect, Fiber, Schema } from "effect";
import { TelemetryWorkRecord } from "../../src/shell/observability/contract";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { makeWorkerTelemetry } from "../runtime/telemetry/operations";
import type { CoreQueueEnvironment } from "./contract";
import { makeCoreQueue } from "./runtime";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const queue = makeCoreQueue(makeWorkerTelemetry(() => undefined));
const userId = "10000000-0000-4000-8000-000000000001";
const identity = (index: number): string =>
  `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
const unused = (): Promise<never> => Promise.reject(new Error("Unexpected platform operation"));
const instance = (id: string): WorkflowInstance => ({
  id,
  pause: unused,
  resume: unused,
  terminate: unused,
  restart: unused,
  delete: unused,
  sendEvent: unused,
  subscribe: unused,
  status: () => Promise.resolve({ status: "running" }),
});
type Owner = "statement" | "billing" | "pairing" | "replacement";
const body = (owner: Owner, index: number): unknown => {
  const id = identity(index);
  switch (owner) {
    case "statement":
      return { version: 1, userId, submissionId: id };
    case "billing":
      return { version: 1, attemptId: id };
    case "pairing":
      return { version: 1, kind: "browser-pairing-email", id };
    case "replacement":
      return { version: 1, kind: "email-replacement", id };
  }
};
const seed = (db: D1Database): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.tryPromise(() =>
      db.batch([
        db.prepare(`CREATE TABLE statement_submissions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL,
      retention_expires_at_ms INTEGER NOT NULL) STRICT`),
        db.prepare(`CREATE TABLE billing_collection_arms (
      attempt_id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT`),
        db.prepare(`CREATE TABLE browser_pairing_email_proofs (
      work_id TEXT PRIMARY KEY, email_address TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL, state TEXT NOT NULL) STRICT`),
        db.prepare(`CREATE TABLE email_replacements (
      work_id TEXT PRIMARY KEY, candidate_email TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL, state TEXT NOT NULL) STRICT`),
      ])
    );
    yield* Effect.tryPromise(() =>
      db.batch(
        Array.from({ length: 10 }, (_, index) => [
          db
            .prepare("INSERT INTO statement_submissions VALUES (?, ?, 'queued', ?)")
            .bind(identity(index), userId, now + 600_000),
          db
            .prepare("INSERT INTO billing_collection_arms VALUES (?, 'armed')")
            .bind(identity(index)),
          db
            .prepare(
              "INSERT INTO browser_pairing_email_proofs VALUES (?, 'test@example.com', ?, 'awaiting_delivery')"
            )
            .bind(identity(index), now + 600_000),
          db
            .prepare(
              "INSERT INTO email_replacements VALUES (?, 'test@example.com', ?, 'awaiting_delivery')"
            )
            .bind(identity(index), now + 600_000),
        ]).flat()
      )
    );
  });
const environment = (
  db: D1Database,
  workflow: Workflow,
  coordinatorCalls: () => void
): CoreQueueEnvironment => ({
  DB: db,
  RELEASE_GIT_SHA: "test",
  USER_TRANSACTION_COORDINATOR: {
    getByName: () => ({
      fetch: () => {
        coordinatorCalls();
        return unused();
      },
    }),
  },
  STATEMENT_EXTRACTION_WORKFLOW: workflow,
  BILLING_COLLECTION_WORKFLOW: workflow,
  BILLING_REFUND_WORKFLOW: workflow,
  BROWSER_PAIRING_EMAIL_WORKFLOW: workflow,
  EMAIL_REPLACEMENT_WORKFLOW: workflow,
});
const batch = (
  messages: ReadonlyArray<Readonly<{ index: number; body: unknown }>>,
  acknowledged: Set<number>,
  attempt: number
): MessageBatch<unknown> => ({
  queue: "application-work",
  metadata: {
    metrics: {
      backlogCount: messages.length,
      backlogBytes: messages.length,
      oldestMessageTimestamp: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
    },
  },
  ackAll: () => {
    for (const message of messages) acknowledged.add(message.index);
  },
  retryAll: () => undefined,
  messages: messages.map((message) => ({
    id: `message-${message.index}`,
    timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
    attempts: attempt,
    body: message.body,
    ack: () => {
      acknowledged.add(message.index);
    },
    retry: () => undefined,
  })),
});

it.each(
  (["statement", "billing", "pairing", "replacement"] as const).flatMap((owner) =>
    [0, 4, 9].map((poison) => ({ owner, poison }))
  )
)(
  "hands off healthy $owner messages despite a failed identity at batch position $poison",
  ({ owner, poison }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => databases.acquire());
        yield* seed(db);
        const created: string[] = [];
        let failedCreates = 0;
        let failedLookups = 0;
        let coordinatorCalls = 0;
        const workflow: Workflow = {
          create: ({ id } = {}) => {
            if (id === identity(poison)) {
              failedCreates += 1;
              return unused();
            }
            if (id === undefined) return unused();
            created.push(id);
            return Promise.resolve(instance(id));
          },
          get: () => {
            failedLookups += 1;
            return unused();
          },
          createBatch: unused,
          deleteBatch: unused,
        };
        const env = environment(db, workflow, () => {
          coordinatorCalls += 1;
        });
        const acknowledged = new Set<number>();
        const messages = Array.from({ length: 10 }, (_, index) => ({
          index,
          body: body(owner, index),
        }));
        let deliveryReads = 0;
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          const pending = messages.filter((message) => !acknowledged.has(message.index));
          deliveryReads += pending.length;
          yield* Effect.tryPromise(() =>
            expect(
              queue(batch(pending, acknowledged, attempt), env).then(
                () => "resolved",
                () => "rejected"
              )
            ).resolves.toBe("rejected")
          );
        }
        const healthy = messages
          .filter((message) => message.index !== poison)
          .map((message) => message.index);
        expect([...acknowledged].toSorted((left, right) => left - right)).toEqual(healthy);
        expect(created.toSorted()).toEqual(healthy.map(identity).toSorted());
        expect(deliveryReads).toBe(13);
        expect(failedCreates).toBe(4);
        expect(failedLookups).toBe(4);
        expect(coordinatorCalls).toBe(0);
        const unchanged = yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT count(*) AS count FROM billing_collection_arms WHERE state = 'armed'")
            .first("count")
        );
        expect(unchanged).toBe(10);
      })
    )
);

it("keeps malformed shared billing work retryable without blocking valid collection or refund identities", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* seed(db);
      const created: string[] = [];
      let coordinatorCalls = 0;
      const workflow: Workflow = {
        create: ({ id } = {}) => {
          if (id === undefined) return unused();
          created.push(id);
          return Promise.resolve(instance(id));
        },
        get: unused,
        createBatch: unused,
        deleteBatch: unused,
      };
      const acknowledged = new Set<number>();
      const messages = [
        { index: 0, body: { version: 999, attemptId: identity(0) } },
        { index: 1, body: body("billing", 1) },
        { index: 2, body: { version: 1, kind: "refund", refundAttemptId: identity(2) } },
      ];
      yield* Effect.tryPromise(() =>
        expect(
          queue(
            batch(messages, acknowledged, 1),
            environment(db, workflow, () => {
              coordinatorCalls += 1;
            })
          )
        ).rejects.toBeDefined()
      );
      expect([...acknowledged]).toEqual([1, 2]);
      expect(created).toEqual([identity(1), `refund-v1-${identity(2)}`]);
      expect(coordinatorCalls).toBe(0);
    })
  ));

it("retains statement ownership and expiry guards while acknowledging confirmed duplicate handoffs", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* seed(db);
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare("UPDATE statement_submissions SET retention_expires_at_ms = 0 WHERE id = ?")
            .bind(identity(1)),
          db
            .prepare("UPDATE statement_submissions SET status = 'completed' WHERE id = ?")
            .bind(identity(2)),
        ])
      );
      let creates = 0;
      let lookups = 0;
      let coordinatorCalls = 0;
      const workflow: Workflow = {
        create: ({ id } = {}) => {
          expect(id).toBe(identity(9));
          creates += 1;
          // Creation succeeded remotely, but both deliveries lose its response.
          return unused();
        },
        get: (id) => {
          expect(id).toBe(identity(9));
          lookups += 1;
          return Promise.resolve(instance(id));
        },
        createBatch: unused,
        deleteBatch: unused,
      };
      const messages = [
        { index: 0, body: { version: 1, userId: identity(0), submissionId: identity(0) } },
        { index: 1, body: body("statement", 1) },
        { index: 2, body: body("statement", 2) },
        { index: 9, body: body("statement", 9) },
        { index: 10, body: body("statement", 9) },
      ];
      const acknowledged = new Set<number>();
      yield* Effect.tryPromise(() =>
        queue(
          batch(messages, acknowledged, 1),
          environment(db, workflow, () => {
            coordinatorCalls += 1;
          })
        )
      );
      expect([...acknowledged]).toEqual([0, 1, 2, 9, 10]);
      expect(creates).toBe(2);
      expect(lookups).toBe(2);
      expect(coordinatorCalls).toBe(0);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT status FROM statement_submissions WHERE id = ?")
            .bind(identity(9))
            .first("status")
        )
      ).toBe("queued");
    })
  ));

it("contains a defective acknowledgement and an ordinary handoff failure in one closed Queue observation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* seed(db);
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE statement_submissions SET status = 'completed' WHERE id = ?")
          .bind(identity(0))
          .run()
      );
      const records: TelemetryWorkRecord[] = [];
      const observedQueue = makeCoreQueue(makeWorkerTelemetry((record) => records.push(record)));
      const privateFailure = "private-acknowledgement-failure-sentinel";
      const workflow: Workflow = {
        create: ({ id } = {}) => (id === identity(2) ? Promise.resolve(instance(id)) : unused()),
        get: unused,
        createBatch: unused,
        deleteBatch: unused,
      };
      const acknowledged = new Set<number>();
      const envelope = batch(
        [0, 1, 2].map((index) => ({ index, body: body("statement", index) })),
        acknowledged,
        1
      );
      const defective = {
        ...envelope,
        messages: envelope.messages.map((message, index) =>
          index === 0
            ? {
                ...message,
                ack: (): void => {
                  throw new Error(privateFailure);
                },
              }
            : message
        ),
      };
      yield* Effect.tryPromise(() =>
        expect(
          observedQueue(
            defective,
            environment(db, workflow, () => undefined)
          ).then(
            () => "resolved",
            () => "rejected"
          )
        ).resolves.toBe("rejected")
      );
      expect([...acknowledged]).toEqual([2]);
      expect(records.map(({ operation, outcome }) => ({ operation, outcome }))).toEqual([
        { operation: "worker.core.queue", outcome: "failed" },
      ]);
      const exported = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Array(TelemetryWorkRecord))
      )(records);
      expect(exported).not.toContain(privateFailure);
    })
  ));

it("stops later handoffs on interruption without acknowledging an ambiguous in-flight create", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* seed(db);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<WorkflowInstance>();
      const context = yield* Effect.context<never>();
      const run = Effect.runPromiseWith(context);
      let creates = 0;
      const workflow: Workflow = {
        create: () => {
          creates += 1;
          Deferred.doneUnsafe(started, Effect.void);
          return run(Deferred.await(release));
        },
        get: unused,
        createBatch: unused,
        deleteBatch: unused,
      };
      const records: TelemetryWorkRecord[] = [];
      const telemetry = makeWorkerTelemetry((record) => records.push(record));
      const interruptedQueue = makeCoreQueue({
        ...telemetry,
        observeWork: (observation, work) =>
          Effect.gen(function* () {
            const fiber = yield* telemetry.observeWork(observation, work).pipe(Effect.forkChild);
            yield* Deferred.await(started);
            yield* Fiber.interrupt(fiber);
            return yield* Fiber.join(fiber);
          }),
      });
      const acknowledged = new Set<number>();
      const messages = [0, 1].map((index) => ({ index, body: body("statement", index) }));
      const outcome = yield* Effect.tryPromise(() =>
        interruptedQueue(
          batch(messages, acknowledged, 1),
          environment(db, workflow, () => undefined)
        )
      ).pipe(Effect.exit, Effect.ensuring(Deferred.succeed(release, instance(identity(0)))));
      expect(outcome._tag).toBe("Failure");
      expect(creates).toBe(1);
      expect(acknowledged.size).toBe(0);
      expect(records.map(({ outcome }) => outcome)).toEqual(["interrupted"]);
    })
  ));
