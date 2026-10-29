import { afterAll, expect, it } from "vitest";
import { type Cause, Clock, DateTime, Deferred, Effect, Fiber, Schema } from "effect";
import { TelemetryWorkRecord } from "../../src/shell/observability/contract";
import { isolatedTestDatabases } from "../d1-test-fixture";
import { makeWorkerTelemetry } from "../runtime/telemetry/operations";
import type { WorkerTelemetryEvent } from "../runtime/telemetry/contract";
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
const body = (owner: Owner, index: number): Readonly<Record<string, unknown>> => {
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
        db.prepare(`CREATE TABLE billing_attempts (
      id TEXT PRIMARY KEY, collection_state TEXT NOT NULL,collection_sent_at_ms INTEGER,collection_last_attempt_at_ms INTEGER) STRICT`),
        db.prepare("CREATE VIEW billing_attempt_context AS SELECT rowid,* FROM billing_attempts"),
        db.prepare(`CREATE TABLE browser_login_pairings (
      email_work_id TEXT PRIMARY KEY, email_address TEXT NOT NULL,
      email_expires_at_ms INTEGER NOT NULL, email_state TEXT NOT NULL) STRICT`),
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
            .prepare("INSERT INTO billing_attempts(id,collection_state) VALUES (?,'armed')")
            .bind(identity(index)),
          db
            .prepare(
              "INSERT INTO browser_login_pairings VALUES (?,'test@example.com',?,'awaiting_delivery')"
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
            .prepare(
              "SELECT count(*) AS count FROM (SELECT rowid,id AS attempt_id,collection_state AS state,collection_sent_at_ms AS sent_at_ms,collection_last_attempt_at_ms AS last_attempt_at_ms FROM billing_attempts WHERE collection_state IS NOT NULL) AS billing_collection_work WHERE state = 'armed'"
            )
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
      expect([...acknowledged].toSorted((left, right) => left - right)).toEqual([0, 1, 2, 9, 10]);
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

it.each(["statement", "pairing", "replacement"] as const)(
  "overlaps independent %s handoffs within a four-message bound",
  (owner) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => databases.acquire());
        yield* seed(db);
        const ready = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const run = Effect.runPromiseWith(yield* Effect.context<never>());
        const now = yield* Clock.currentTimeMillis;
        const events: WorkerTelemetryEvent[] = [];
        const observedQueue = makeCoreQueue(
          makeWorkerTelemetry({
            exportWork: () => undefined,
            exportEvent: (event) => events.push(event),
          })
        );
        const parents = Array.from({ length: 10 }, (_, index) => ({
          version: 1 as const,
          traceId: String(index + 1).padStart(32, "0"),
          parentSpanId: String(index + 1).padStart(16, "0"),
          sampled: true,
          capturedAtUnixMilliseconds: now,
        }));
        let active = 0;
        let maximum = 0;
        let creates = 0;
        const workflow: Workflow = {
          create: ({ id } = {}) => {
            if (id === undefined) return unused();
            creates += 1;
            active += 1;
            maximum = Math.max(maximum, active);
            if (active === 4) Deferred.doneUnsafe(ready, Effect.void);
            return run(Deferred.await(release)).then(() => {
              active -= 1;
              return instance(id);
            });
          },
          get: unused,
          createBatch: unused,
          deleteBatch: unused,
        };
        const acknowledged = new Set<number>();
        const pending = observedQueue(
          batch(
            parents.map((traceContext, index) => ({
              index,
              body: { ...body(owner, index), traceContext },
            })),
            acknowledged,
            1
          ),
          environment(db, workflow, () => undefined)
        );
        yield* Deferred.await(ready).pipe(
          Effect.timeout(5_000),
          Effect.tap(() => Effect.sync(() => expect(creates).toBe(4))),
          Effect.ensuring(Deferred.succeed(release, undefined)),
          Effect.onError(() => Effect.tryPromise(() => pending).pipe(Effect.ignoreCause))
        );
        yield* Effect.tryPromise(() => pending);
        expect(creates).toBe(10);
        expect(maximum).toBe(4);
        expect(acknowledged.size).toBe(10);
        const attempts = events.flatMap((event) =>
          event.event === "span" && event.data["fidy.work_kind"] === "queue_attempt"
            ? [
                {
                  traceId: event.traceId,
                  parentSpanId: event.parentSpanId,
                  outcome: event.data["fidy.outcome"],
                },
              ]
            : []
        );
        expect(
          attempts.toSorted((left, right) => left.traceId.localeCompare(right.traceId))
        ).toEqual(
          parents.map(({ traceId, parentSpanId }) => ({
            traceId,
            parentSpanId,
            outcome: "succeeded",
          }))
        );
      })
    ),
  15_000
);

it("retains input-order failure selection when independent handoffs fail in reverse order", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* seed(db);
      const release = yield* Deferred.make<void>();
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      const first = new Error("first-private-provider-failure");
      const second = new Error("second-private-provider-failure");
      const workflow: Workflow = {
        create: ({ id } = {}) => {
          if (id === undefined) return unused();
          if (id === identity(0)) {
            return run(Deferred.await(release)).then(() => Promise.reject(first));
          }
          return id === identity(1) ? Promise.reject(second) : Promise.resolve(instance(id));
        },
        get: (id) => {
          if (id === identity(1)) Deferred.doneUnsafe(release, Effect.void);
          return Promise.reject(id === identity(0) ? first : second);
        },
        createBatch: unused,
        deleteBatch: unused,
      };
      const acknowledged = new Set<number>();
      yield* Effect.tryPromise(() =>
        expect(
          queue(
            batch(
              Array.from({ length: 10 }, (_, index) => ({ index, body: body("statement", index) })),
              acknowledged,
              1
            ),
            environment(db, workflow, () => undefined)
          )
        ).rejects.toMatchObject({ cause: first })
      ).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      expect([...acknowledged].toSorted((left, right) => left - right)).toEqual([
        2, 3, 4, 5, 6, 7, 8, 9,
      ]);
    })
  ));

it("stops the remaining backlog on interruption without acknowledging four ambiguous creates", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());
      yield* seed(db);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const context = yield* Effect.context<never>();
      const run = Effect.runPromiseWith(context);
      let creates = 0;
      const workflow: Workflow = {
        create: ({ id } = {}) => {
          if (id === undefined) return unused();
          creates += 1;
          if (creates === 4) Deferred.doneUnsafe(started, Effect.void);
          return run(Deferred.await(release)).then(() => instance(id));
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
      const messages = Array.from({ length: 10 }, (_, index) => ({
        index,
        body: body("statement", index),
      }));
      const outcome = yield* Effect.tryPromise(() =>
        interruptedQueue(
          batch(messages, acknowledged, 1),
          environment(db, workflow, () => undefined)
        )
      ).pipe(Effect.exit, Effect.ensuring(Deferred.succeed(release, undefined)));
      expect(outcome._tag).toBe("Failure");
      expect(creates).toBe(4);
      expect(acknowledged.size).toBe(0);
      expect(records.map(({ outcome }) => outcome)).toEqual(["interrupted"]);
    })
  ));
