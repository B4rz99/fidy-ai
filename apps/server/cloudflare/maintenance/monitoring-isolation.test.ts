import { type ProactivityDeliveryWork } from "../insights/contract";
import { type CoreMaintenanceInput, ScheduledWorkFailed } from "./contract";
import { fixtureWorker as coreWorker } from "../core-worker.test-fixture";
import { coordinatorProbeName } from "../runtime/operational-health/contract";
import assert from "node:assert/strict";
import { Clock, Effect, Exit, Option } from "effect";
import { afterAll, expect, it, vi } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { runCoreMaintenance } from "./runtime";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
const unavailable = (): never => {
  throw new Error("private platform diagnostic");
};
const environment = (
  db: D1Database,
  overrides: Partial<CoreMaintenanceInput> = {}
): CoreMaintenanceInput => ({
  DB: db,
  USER_TRANSACTION_COORDINATOR: { getByName: unavailable },
  AI: { run: unavailable },
  RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  KAPSO_API_KEY: "configured",
  WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
  KAPSO_WEBHOOK_SECRET: "configured",
  HOSTED_AI_MODEL: "configured",
  WOMPI_ENVIRONMENT: "configured",
  WOMPI_PUBLIC_KEY: "configured",
  WOMPI_PRIVATE_KEY: "configured",
  WOMPI_INTEGRITY_SECRET: "configured",
  ASYNC_HEALTH_ENABLED: Option.none(),
  ASYNC_DEAD_LETTERS: Option.none(),
  FORWARDED_EMAIL_QUEUE: Option.none(),
  EMAIL_REPLACEMENT_HEALTH_QUEUE: Option.none(),
  OPERATIONAL_CANARY_QUEUE: Option.none(),
  OPERATIONAL_CANARY_WORKFLOW: Option.none(),
  EMAIL_BUCKET: Option.none(),
  STATEMENT_STAGING_BUCKET: Option.none(),
  BROWSER_PAIRING_EMAIL_QUEUE: Option.none(),
  EMAIL_REPLACEMENT_QUEUE: Option.none(),
  BILLING_COLLECTION_QUEUE: Option.none(),
  STATEMENT_EXTRACTION_QUEUE: Option.none(),
  HOSTED_WHATSAPP_QUEUE: Option.none(),
  BROWSER_PAIRING_EMAIL_WORKFLOW: Option.none(),
  EMAIL_REPLACEMENT_WORKFLOW: Option.none(),
  BILLING_COLLECTION_WORKFLOW: Option.none(),
  STATEMENT_EXTRACTION_WORKFLOW: Option.none(),
  RESEND_API_KEY: Option.none(),
  WOMPI_EVENT_SECRET: Option.none(),
  ...overrides,
});

it("a stalled canary offer cannot skip later Core retention or manufacture execution success", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());

      yield* Effect.tryPromise(() => installTestSchema({ db }));
      yield* Effect.tryPromise(() =>
        db.batch([
          db.prepare(
            "INSERT INTO resource_admission_events(grant_id,policy_key,dimension,scope_key,policy_kind,units,admitted_at_epoch_ms,window_start_epoch_ms,expires_at_epoch_ms,released_at_epoch_ms) VALUES ('workers-ai-expired','test','operation','test','rolling_window',1,1,1,2,NULL)"
          ),
          db.prepare("INSERT INTO resource_admission_grants VALUES ('workers-ai-expired',1,1)"),
        ])
      );
      const current = Math.floor((yield* Clock.currentTimeMillis) / 3_600_000) * 3_600_000 + 5_000;
      const liveClock = yield* Clock.Clock;
      const canaryClock: Clock.Clock = {
        currentTimeMillis: Effect.succeed(current),
        currentTimeMillisUnsafe: () => current,
        currentTimeNanos: liveClock.currentTimeNanos,
        currentTimeNanosUnsafe: () => liveClock.currentTimeNanosUnsafe(),
        monotonicTimeNanos: liveClock.monotonicTimeNanos,
        monotonicTimeNanosUnsafe: () => liveClock.monotonicTimeNanosUnsafe(),
        sleep: (duration) => liveClock.sleep(duration),
      };
      const held = Promise.withResolvers<QueueSendResponse>();
      const send = vi.fn(() => held.promise);
      try {
        const result = yield* Effect.tryPromise(() =>
          Effect.runPromiseExit(
            runCoreMaintenance(
              environment(db, {
                ASYNC_HEALTH_ENABLED: Option.some("enabled"),
                OPERATIONAL_CANARY_QUEUE: Option.some({ send }),
              })
            ).pipe(Effect.provideService(Clock.Clock, canaryClock)),
            { signal: AbortSignal.timeout(5_000) }
          )
        );
        assert.deepStrictEqual(result, Exit.fail(new ScheduledWorkFailed()));
        expect(send).toHaveBeenCalledOnce();
        expect(
          yield* Effect.tryPromise(() =>
            db.prepare("SELECT count(*) AS count FROM resource_admission_grants").first()
          )
        ).toEqual({ count: 0 });
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT operation AS kind,last_succeeded_ms FROM operational_health_view WHERE last_succeeded_ms IS NOT NULL"
              )
              .all()
          )
        ).toMatchObject({
          results: [],
        });
      } finally {
        held.resolve({ metadata: { metrics: { backlogCount: 1, backlogBytes: 34 } } });
      }
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT operation AS kind,last_succeeded_ms FROM operational_health_view WHERE last_succeeded_ms IS NOT NULL"
            )
            .all()
        )
      ).toMatchObject({ results: [] });
      expect(send).toHaveBeenCalledOnce();
    })
  ));

const quietQueue: Queue = {
  send: () => Promise.resolve({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
  sendBatch: () => Promise.resolve({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
  metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
};
const emptyBucket: R2Bucket = {
  head: unavailable,
  get: unavailable,
  put: unavailable,
  createMultipartUpload: unavailable,
  resumeMultipartUpload: unavailable,
  delete: unavailable,
  list: () => Promise.resolve({ objects: [], truncated: false, delimitedPrefixes: [] }),
};
const idleWorkflow: Workflow = {
  create: unavailable,
  createBatch: unavailable,
  deleteBatch: unavailable,
  get: unavailable,
};
const scheduledEnvironment = (db: D1Database): Parameters<typeof coreWorker.scheduled>[1] => ({
  DB: db,
  AI: { run: unavailable },
  BROWSER_ORIGIN: "https://example.test",
  CLOUDFLARE_ACCESS_AUDIENCE: "",
  CLOUDFLARE_ACCESS_ISSUER: "",
  CONTRACT_DIGEST: "a".repeat(64),
  HOSTED_AI_MODEL: "configured",
  KAPSO_API_KEY: "configured",
  KAPSO_WEBHOOK_SECRET: "configured",
  RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  WHATSAPP_BUSINESS_PORTFOLIO_ID: "configured",
  WHATSAPP_SANDBOX_PHONE_NUMBER_ID: "",
  WOMPI_ENVIRONMENT: "configured",
  WOMPI_PUBLIC_KEY: "configured",
  WOMPI_PRIVATE_KEY: "configured",
  WOMPI_INTEGRITY_SECRET: "configured",
  USER_TRANSACTION_COORDINATOR: {
    getByName: (name) => {
      if (name !== coordinatorProbeName) return unavailable();
      return { fetch: () => Promise.resolve(new Response(null, { status: 204 })) };
    },
  },
  ASYNC_HEALTH_ENABLED: "enabled",
  ASYNC_DEAD_LETTERS: quietQueue,
  OPERATIONAL_CANARY_QUEUE: quietQueue,
  OPERATIONAL_CANARY_WORKFLOW: idleWorkflow,
  EMAIL_BUCKET: emptyBucket,
  STATEMENT_STAGING_BUCKET: emptyBucket,
  STATEMENT_EXTRACTION_QUEUE: quietQueue,
  STATEMENT_EXTRACTION_WORKFLOW: idleWorkflow,
  BROWSER_PAIRING_EMAIL_QUEUE: quietQueue,
  BROWSER_PAIRING_EMAIL_WORKFLOW: idleWorkflow,
  EMAIL_REPLACEMENT_QUEUE: quietQueue,
  EMAIL_REPLACEMENT_WORKFLOW: idleWorkflow,
  BILLING_COLLECTION_QUEUE: quietQueue,
  BILLING_COLLECTION_WORKFLOW: idleWorkflow,
  HOSTED_WHATSAPP_QUEUE: quietQueue,
  FORWARDED_EMAIL_QUEUE: quietQueue,
  EMAIL_REPLACEMENT_HEALTH_QUEUE: quietQueue,
});

it.each([
  {
    label: "category-only",
    weekly: "disabled",
    category: "enabled",
    missing: "neither",
    expectedKinds: ["category"],
    expectedMetrics: 1,
    expectedPending: "attention",
    expectedQueue: "attention",
    expectedBindings: "healthy",
  },
  {
    label: "both categories",
    weekly: "enabled",
    category: "enabled",
    missing: "neither",
    expectedKinds: ["category", "weekly"],
    expectedMetrics: 1,
    expectedPending: "attention",
    expectedQueue: "attention",
    expectedBindings: "healthy",
  },
  {
    label: "weekly-only",
    weekly: "enabled",
    category: "disabled",
    missing: "neither",
    expectedKinds: ["weekly"],
    expectedMetrics: 1,
    expectedPending: "attention",
    expectedQueue: "attention",
    expectedBindings: "healthy",
  },
  {
    label: "both disabled",
    weekly: "disabled",
    category: "disabled",
    missing: "both",
    expectedKinds: [],
    expectedMetrics: 0,
    expectedPending: "omitted",
    expectedQueue: "omitted",
    expectedBindings: "healthy",
  },
  {
    label: "category Queue absent",
    weekly: "disabled",
    category: "enabled",
    missing: "queue",
    expectedKinds: ["category"],
    expectedMetrics: 0,
    expectedPending: "attention",
    expectedQueue: "unavailable",
    expectedBindings: "unavailable",
  },
  {
    label: "category Workflow absent",
    weekly: "disabled",
    category: "enabled",
    missing: "workflow",
    expectedKinds: [],
    expectedMetrics: 1,
    expectedPending: "attention",
    expectedQueue: "attention",
    expectedBindings: "unavailable",
  },
] as const)("Core scheduled health preserves $label enablement through normalization", (scenario) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* Effect.tryPromise(() => databases.acquire());

      yield* Effect.tryPromise(() => installTestSchema({ db }));
      const now = yield* Clock.currentTimeMillis;
      const userId = "90000000-0000-4000-8000-000000000011";
      const deliveryId = "90000000-0000-4000-8000-000000000012";
      const questionId = "90000000-0000-4000-8000-000000000013";
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare(
              "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',?)"
            )
            .bind(userId, now),
          db
            .prepare(
              "INSERT INTO proactive_messages(kind,id,user_id,role,offer_id,text,scheduled_at_ms,expires_at_ms,time_zone,created_at_ms) VALUES ('proactivity-delivery',?,?,'budget-offer',?,'private-report',?,?,'UTC',?)"
            )
            .bind(deliveryId, userId, deliveryId, now - 600_000, now + 3_600_000, now - 600_000),
          db
            .prepare(
              "UPDATE proactive_messages SET dispatch_created_at_ms=incoming.created_at_ms,dispatch_state=incoming.state,dispatch_last_attempt_at_ms=incoming.last_attempt_at_ms,dispatch_restart_attempts=incoming.restart_attempts FROM (SELECT source.*, 0 AS restart_attempts FROM (SELECT source.*, 0 AS last_attempt_at_ms FROM (SELECT 'proactivity-delivery' AS kind,? AS user_id,? AS delivery_id,? AS created_at_ms,'started' AS state) AS source) AS source) AS incoming WHERE proactive_messages.user_id=incoming.user_id AND proactive_messages.kind=incoming.kind AND proactive_messages.id=incoming.delivery_id AND proactive_messages.dispatch_state IS NULL"
            )
            .bind(userId, deliveryId, now - 600_000),
          db
            .prepare(
              "INSERT INTO weekly_question_requests(id,user_id,origin,created_at_ms,state,last_attempt_at_ms,restart_attempts) VALUES (?,?,'requested',?,'ready',0,0)"
            )
            .bind(questionId, userId, now - 300_000),
        ])
      );
      const inspected: string[] = [];
      const metrics = vi.fn(() => Promise.resolve({ backlogCount: 3, backlogBytes: 60 }));
      const queue: Queue<ProactivityDeliveryWork> = { ...quietQueue, metrics };
      const workflow: Workflow<ProactivityDeliveryWork> = {
        create: unavailable,
        createBatch: unavailable,
        deleteBatch: unavailable,
        get: (id) => {
          inspected.push(id);
          return Promise.resolve({
            id,
            pause: unavailable,
            resume: unavailable,
            terminate: unavailable,
            restart: unavailable,
            delete: unavailable,
            sendEvent: unavailable,
            subscribe: unavailable,
            status: () => Promise.resolve({ status: "errored" }),
          });
        },
      };
      const outcome = yield* Effect.exit(
        Effect.tryPromise(() =>
          coreWorker.scheduled(
            { cron: "* * * * *", noRetry: () => undefined, scheduledTime: now },
            {
              ...scheduledEnvironment(db),
              WEEKLY_SUMMARY_ENABLED: scenario.weekly,
              PROACTIVITY_ENABLED: scenario.category,
              ...(scenario.missing === "queue" || scenario.missing === "both"
                ? {}
                : { WEEKLY_DELIVERY_QUEUE: queue }),
              ...(scenario.missing === "workflow" || scenario.missing === "both"
                ? {}
                : { WEEKLY_DELIVERY_WORKFLOW: workflow }),
            }
          )
        )
      );
      expect(Exit.isSuccess(outcome)).toBe(scenario.expectedBindings === "healthy");
      const identities = {
        category: `weekly-${userId}-proactivity-delivery-${deliveryId}`,
        weekly: `weekly-${userId}-weekly-question-${questionId}`,
      };
      expect(inspected).toEqual(scenario.expectedKinds.map((kind) => identities[kind]));
      expect(metrics).toHaveBeenCalledTimes(scenario.expectedMetrics);
      const observed = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT operation,state FROM operational_health_view WHERE operation IN ('proactivity','proactivityQueue','requiredBindings') ORDER BY operation"
          )
          .all()
      );
      expect(observed.results).toEqual([
        ...(scenario.expectedPending === "omitted"
          ? []
          : [{ operation: "proactivity", state: scenario.expectedPending }]),
        ...(scenario.expectedQueue === "omitted"
          ? []
          : [{ operation: "proactivityQueue", state: scenario.expectedQueue }]),
        { operation: "requiredBindings", state: scenario.expectedBindings },
      ]);
    })
  )
);
