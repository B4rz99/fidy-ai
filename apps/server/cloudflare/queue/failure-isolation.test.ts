import { expect, it } from "vitest";
import {
  Clock,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  type FileSystem,
  Schema,
  type Scope,
} from "effect";
import { TelemetryWorkRecord } from "../../src/shell/observability/contract";
import { NodeFileSystem } from "@effect/platform-node";
import { alice, seed as seedUser } from "../financial-user-store.test-fixture";
import { native, nativeUserPlatform } from "../user-store.test-fixture";
import { currentDisclosureFor } from "../../src/shell/consent/operations";
import { DisclosureSnapshot } from "../../src/shell/consent/contract";
import { makeWorkerTelemetry } from "../runtime/telemetry/operations";
import type { WorkerTelemetryEvent } from "../runtime/telemetry/contract";
import type { CoreQueueEnvironment } from "./contract";
import { coreQueue } from "./runtime";
import { LocalBillingCollection, LocalRefundWork } from "../subscription/contract";
import { UserId } from "../../src/core/identity/contract";
import { BillingAttemptId, RefundAttemptId } from "../../src/core/subscription/contract";

const makeCoreQueue =
  (
    telemetry: Parameters<typeof coreQueue>[0]
  ): ((...args: Parameters<ReturnType<typeof coreQueue>>) => Promise<void>) =>
  (...args) =>
    Effect.runPromise(coreQueue(telemetry)(...args));

const queue = makeCoreQueue(makeWorkerTelemetry(() => undefined));

const userId = alice.user;

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

type Owner = "statement" | "billing" | "pairing";

const refundWork = LocalRefundWork.make({
  userId: Schema.decodeSync(UserId)(userId),
  refundAttemptId: Schema.decodeSync(RefundAttemptId)(identity(2)),
  verification: 0,
});

type QueueBody =
  | Readonly<{ version: 1; userId: string; submissionId: string }>
  | typeof LocalBillingCollection.Type
  | Readonly<{ version: 2; kind: "browser-pairing-email"; userId: string; id: string }>;

const body = (owner: Owner, index: number): QueueBody => {
  const id = identity(index);

  switch (owner) {
    case "statement":
      return { version: 1, userId, submissionId: id };
    case "billing":
      return LocalBillingCollection.make({
        userId: Schema.decodeSync(UserId)(userId),
        attemptId: Schema.decodeSync(BillingAttemptId)(id),
      });
    case "pairing":
      return { version: 2, kind: "browser-pairing-email", userId, id };
  }
};

const run = <A, E>(work: Effect.Effect<A, E, Scope.Scope | FileSystem.FileSystem>): Promise<A> =>
  Effect.runPromise(work.pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)));

const seed = Effect.fn(function* () {
  const runtime = yield* (yield* nativeUserPlatform)();
  const owner = yield* seedUser(runtime, alice, false);
  yield* owner.exec(
    "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms,disclosure_json) VALUES(?,?,'processing_grant',?,?)",
    identity(100),
    userId,
    owner.now,
    yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(currentDisclosureFor())
  );

  yield* Effect.forEach(
    Array.from({ length: 10 }, (_, index) => index),
    (index) =>
      Effect.gen(function* () {
        const id = identity(index);
        yield* owner.exec(
          "INSERT INTO statement_staging_objects(id,user_id,object_key,byte_length,sha256,status,created_at_ms,expires_at_ms,published_submission_id,source_format) VALUES(?,?,?,1,?,'published',?,?,?,'csv')",
          id,
          userId,
          "users/" + userId + "/" + id,
          "f".repeat(64),
          owner.now,
          owner.now + 600000,
          id
        );
        yield* owner.exec(
          "INSERT INTO statement_submissions(id,user_id,idempotency_key,staging_id,submitted_at_ms,retention_expires_at_ms,source_format,parser_revision,service_market,locale,time_zone) VALUES (?,?,?,?,?,?,'csv','v1','CO','es-CO','America/Bogota')",
          id,
          userId,
          id,
          id,
          owner.now,
          owner.now + 600000
        );
      }),
    { discard: true }
  );

  const namespace = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));

  const users: NonNullable<CoreQueueEnvironment["USER_STORE"]> = {
    getByName: (name) => ({
      fetch: (input, init) => {
        const request = new Request(input, init);

        return request
          .text()
          .then((body) =>
            namespace.getByName(name).fetch(request.url, { method: request.method, body })
          )
          .then((response) => new Response(null, { status: response.status }));
      },
    }),
  };

  return { owner, users };
});

const environment = (workflow: Workflow, coordinatorCalls: () => void): CoreQueueEnvironment => ({
  RELEASE_GIT_SHA: "test",
  USER_STORE: {
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
  (["statement", "billing", "pairing"] as const).flatMap((owner) =>
    [0, 4, 9].map((poison) => ({ owner, poison }))
  )
)(
  "hands off healthy $owner messages despite a failed identity at batch position $poison",
  ({ owner, poison }) =>
    run(
      Effect.gen(function* () {
        const { users } = yield* seed();
        const created: string[] = [];
        let failedCreates = 0;
        let failedLookups = 0;
        let coordinatorCalls = 0;

        const workflowId = (index: number): string =>
          owner === "billing" ? "collect-" + userId + "-" + identity(index) : identity(index);

        const workflow: Workflow = {
          create: ({ id } = {}) => {
            if (id === workflowId(poison)) {
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

        const shared = environment(workflow, () => {
          coordinatorCalls += 1;
        });

        const env = owner === "statement" ? { ...shared, USER_STORE: users } : shared;

        const acknowledged = new Set<number>();

        const messages = Array.from({ length: 10 }, (_, index) => ({
          index,
          body: body(owner, index),
        }));

        let deliveryReads = 0;

        yield* Effect.forEach(
          [1, 2, 3, 4],
          Effect.fnUntraced(function* (attempt) {
            const pending = messages.filter((message) => !acknowledged.has(message.index));

            deliveryReads += pending.length;

            const outcome = yield* Effect.exit(
              Effect.tryPromise(() => queue(batch(pending, acknowledged, attempt), env))
            );

            expect(Exit.isFailure(outcome)).toBe(true);
          }),
          { discard: true }
        );

        const healthy = messages
          .filter((message) => message.index !== poison)
          .map((message) => message.index);

        expect([...acknowledged].toSorted((left, right) => left - right)).toEqual(healthy);
        expect(created.toSorted()).toEqual(healthy.map(workflowId).toSorted());
        expect(deliveryReads).toBe(13);
        expect(failedCreates).toBe(4);
        expect(failedLookups).toBe(4);
        expect(coordinatorCalls).toBe(0);
      })
    )
);

it("keeps malformed shared billing work retryable without blocking valid collection or refund identities", () =>
  run(
    Effect.gen(function* () {
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
        {
          index: 2,
          body: refundWork,
        },
      ];

      yield* Effect.tryPromise(() =>
        expect(
          queue(
            batch(messages, acknowledged, 1),
            environment(workflow, () => {
              coordinatorCalls += 1;
            })
          )
        ).rejects.toBeDefined()
      );
      expect([...acknowledged]).toEqual([1, 2]);
      expect(created).toEqual([
        "collect-" + userId + "-" + identity(1),
        `refund-${userId}-${identity(2)}-0`,
      ]);
      expect(coordinatorCalls).toBe(0);
    })
  ));

it("retains statement ownership and expiry guards while acknowledging confirmed duplicate handoffs", () =>
  run(
    Effect.gen(function* () {
      const { owner, users } = yield* seed();
      yield* owner.exec(
        "UPDATE statement_submissions SET retention_expires_at_ms=0 WHERE id=?",
        identity(1)
      );
      yield* owner.exec(
        "UPDATE statement_submissions SET status='completed' WHERE id=?",
        identity(2)
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
        queue(batch(messages, acknowledged, 1), {
          ...environment(workflow, () => {
            coordinatorCalls += 1;
          }),
          USER_STORE: users,
        })
      );
      expect([...acknowledged].toSorted((left, right) => left - right)).toEqual([0, 1, 2, 9, 10]);
      expect(creates).toBe(2);
      expect(lookups).toBe(2);
      expect(coordinatorCalls).toBe(0);
      expect(
        yield* owner.exec("SELECT status FROM statement_submissions WHERE id=?", identity(9))
      ).toEqual([{ status: "queued" }]);
    })
  ));

it("contains a defective acknowledgement and an ordinary handoff failure in one closed Queue observation", () =>
  run(
    Effect.gen(function* () {
      const { owner, users } = yield* seed();
      yield* owner.exec(
        "UPDATE statement_submissions SET status='completed' WHERE id=?",
        identity(0)
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
          observedQueue(defective, {
            ...environment(workflow, () => undefined),
            USER_STORE: users,
          }).then(
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

const independentHandoffs = [
  { owner: "statement", limit: 8 },
  { owner: "pairing", limit: 4 },
] as const;

it("fails every parallel handoff closed when its User owner binding is absent", () =>
  run(
    Effect.gen(function* () {
      let creates = 0;

      const workflow: Workflow = {
        create: ({ id } = {}) => {
          if (id === undefined) return unused();
          creates += 1;

          return Promise.resolve(instance(id));
        },
        get: unused,
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
            environment(workflow, () => undefined)
          )
        ).rejects.toBeDefined()
      );
      expect(creates).toBe(0);
      expect(acknowledged.size).toBe(0);
    })
  ));

it.each(independentHandoffs)(
  "overlaps independent $owner handoffs within a $limit-message bound",
  ({ owner, limit }) =>
    run(
      Effect.gen(function* () {
        const { users } = yield* seed();
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

            if (active === limit) Deferred.doneUnsafe(ready, Effect.void);

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
          { ...environment(workflow, () => undefined), USER_STORE: users }
        );

        yield* Deferred.await(ready).pipe(
          Effect.timeout(Duration.seconds(5)),
          Effect.tap(() => Effect.sync(() => expect(creates).toBe(limit))),
          Effect.ensuring(Deferred.succeed(release, undefined)),
          Effect.onError(() => Effect.tryPromise(() => pending).pipe(Effect.ignoreCause))
        );
        yield* Effect.tryPromise(() => pending);
        expect(creates).toBe(10);
        expect(maximum).toBe(limit);
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
    )
);

it("retains input-order failure selection when independent handoffs fail in reverse order", () =>
  run(
    Effect.gen(function* () {
      const { users } = yield* seed();
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
            { ...environment(workflow, () => undefined), USER_STORE: users }
          )
        ).rejects.toMatchObject({ cause: first })
      ).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      expect([...acknowledged].toSorted((left, right) => left - right)).toEqual([
        2, 3, 4, 5, 6, 7, 8, 9,
      ]);
    })
  ));

it.each(independentHandoffs)(
  "stops the $owner backlog on interruption without acknowledging $limit ambiguous creates",
  ({ owner, limit }) =>
    run(
      Effect.gen(function* () {
        const { users } = yield* seed();
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const context = yield* Effect.context<never>();
        const run = Effect.runPromiseWith(context);
        let creates = 0;

        const workflow: Workflow = {
          create: ({ id } = {}) => {
            if (id === undefined) return unused();
            creates += 1;

            if (creates === limit) Deferred.doneUnsafe(started, Effect.void);

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
          body: body(owner, index),
        }));

        const outcome = yield* Effect.tryPromise(() =>
          interruptedQueue(batch(messages, acknowledged, 1), {
            ...environment(workflow, () => undefined),
            USER_STORE: users,
          })
        ).pipe(Effect.exit, Effect.ensuring(Deferred.succeed(release, undefined)));

        expect(outcome._tag).toBe("Failure");
        expect(creates).toBe(limit);
        expect(acknowledged.size).toBe(0);
        expect(records.map(({ outcome }) => outcome)).toEqual(["interrupted"]);
      })
    )
);
