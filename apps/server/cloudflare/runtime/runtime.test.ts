import { type PlatformMaintenanceInput, PlatformMaintenanceUnavailable } from "./contract";
import { deepStrictEqual } from "node:assert";
import { it } from "@effect/vitest";
import { Effect, Exit, Logger, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, expect } from "vitest";
import { installTestSchema, isolatedTestStorage } from "../d1-test-fixture";
import { makePlatformMaintenance } from "./runtime";

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const unavailable = (): never => {
  throw new Error("private platform diagnostic");
};
const queue: Queue = { send: unavailable, sendBatch: unavailable, metrics: unavailable };
const input = (
  db: D1Database,
  overrides: Partial<PlatformMaintenanceInput> = {}
): PlatformMaintenanceInput => ({
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

it.effect("keeps disabled operational work inert but refuses an enabled missing canary Queue", () =>
  Effect.gen(function* () {
    const { db } = yield* Effect.tryPromise(() => storage.acquire());
    const disabled = makePlatformMaintenance(input(db));
    yield* disabled.inspectHealth();
    yield* disabled.publishCanary(600_000);
    const enabled = makePlatformMaintenance(
      input(db, { ASYNC_HEALTH_ENABLED: Option.some("enabled") })
    );
    deepStrictEqual(
      yield* Effect.exit(enabled.publishCanary(600_000)),
      Exit.fail(new PlatformMaintenanceUnavailable())
    );
  })
);

it.effect("publishes a period-bounded canary and closes Queue rejection details", () =>
  Effect.gen(function* () {
    const { db } = yield* Effect.tryPromise(() => storage.acquire());
    const published: unknown[] = [];
    const enabled = input(db, { ASYNC_HEALTH_ENABLED: Option.some("enabled") });
    yield* makePlatformMaintenance({
      ...enabled,
      OPERATIONAL_CANARY_QUEUE: Option.some({
        send: (body) => {
          published.push(body);
          return Promise.resolve({ metadata: { metrics: { backlogCount: 1, backlogBytes: 34 } } });
        },
      }),
    }).publishCanary(650_123);
    expect(published).toEqual([{ version: 1, sentAtMs: 600_000 }]);
    deepStrictEqual(
      yield* Effect.exit(
        makePlatformMaintenance({
          ...enabled,
          OPERATIONAL_CANARY_QUEUE: Option.some(queue),
        }).publishCanary(650_123)
      ),
      Exit.fail(new PlatformMaintenanceUnavailable())
    );
  })
);

it.effect("reports bounded measurements and readiness through closed platform observations", () =>
  Effect.gen(function* () {
    const { db } = yield* Effect.tryPromise(() => storage.acquire());
    let backlogCount = 1000;
    const logs: Array<unknown> = [];
    const logger = Logger.make<unknown, void>(({ message }) => logs.push(message));
    const loggers = new Set([logger]);
    const configured = input(db, {
      ASYNC_HEALTH_ENABLED: Option.some("enabled"),
      RESEND_API_KEY: Option.some("configured"),
      WOMPI_EVENT_SECRET: Option.some("configured"),
      BILLING_COLLECTION_QUEUE: Option.some({
        ...queue,
        metrics: () => Promise.resolve({ backlogCount, backlogBytes: 1000 }),
      }),
      USER_TRANSACTION_COORDINATOR: {
        getByName: () => ({
          fetch: (): Promise<Response> => Promise.resolve(new Response(null, { status: 204 })),
        }),
      },
    });
    yield* makePlatformMaintenance(configured)
      .inspectHealth()
      .pipe(Effect.provideService(Logger.CurrentLoggers, loggers));
    expect(logs).toEqual(
      expect.arrayContaining([
        [
          {
            component: "inspection-coverage",
            operation: "ownerInspections",
            state: "complete",
            message:
              "fidy.operational component=inspection-coverage operation=ownerInspections state=complete",
          },
        ],
        [
          {
            component: "capability",
            operation: "d1",
            state: "healthy",
            severity: "none",
            message:
              "fidy.operational component=capability operation=d1 state=healthy severity=none",
          },
        ],
        [
          {
            component: "capability",
            operation: "requiredBindings",
            state: "unavailable",
            severity: "warning",
            message:
              "fidy.operational component=capability operation=requiredBindings state=unavailable severity=warning",
          },
        ],
        [
          {
            component: "async-health",
            operation: "billingQueue",
            state: "attention",
            backlogCount: 1000,
            backlogBytes: 1000,
            severity: "critical",
            message:
              "fidy.operational component=async-health operation=billingQueue state=attention severity=critical",
          },
        ],
      ])
    );
    logs.length = 0;
    backlogCount = 99;
    yield* Effect.exit(
      makePlatformMaintenance({
        ...configured,
        RESEND_API_KEY: Option.some("  "),
      })
        .inspectHealth()
        .pipe(Effect.provideService(Logger.CurrentLoggers, loggers))
    );
    expect(logs).toContainEqual([
      {
        component: "async-health",
        operation: "billingQueue",
        state: "attention",
        backlogCount: 99,
        backlogBytes: 1000,
        severity: "none",
        message:
          "fidy.operational component=async-health operation=billingQueue state=attention severity=none",
      },
    ]);
    expect(logs).toContainEqual([
      {
        component: "capability",
        operation: "providerConfig",
        state: "unavailable",
        severity: "warning",
        message:
          "fidy.operational component=capability operation=providerConfig state=unavailable severity=warning",
      },
    ]);
  })
);

it.effect("reports D1 unavailability and complete owner inspection after recovery", () =>
  Effect.gen(function* () {
    const { db } = yield* Effect.tryPromise(() => storage.acquire());
    const unavailableDb: D1Database = {
      prepare: unavailable,
      batch: unavailable,
      exec: unavailable,
      withSession: unavailable,
      dump: unavailable,
    };
    const logs: Array<unknown> = [];
    const loggers = new Set([Logger.make<unknown, void>(({ message }) => logs.push(message))]);
    const inspect = (database: D1Database): Effect.Effect<void> =>
      makePlatformMaintenance(
        input(database, {
          ASYNC_HEALTH_ENABLED: Option.some("enabled"),
          RESEND_API_KEY: Option.some("test-only-key"),
        })
      )
        .inspectHealth()
        .pipe(
          Effect.provideService(Logger.CurrentLoggers, loggers),
          Effect.andThen(TestClock.adjust("1 millis")),
          Effect.ignore
        );
    yield* inspect(unavailableDb);
    expect(logs).toContainEqual([
      {
        component: "inspection-coverage",
        operation: "ownerInspections",
        state: "incomplete",
        message:
          "fidy.operational component=inspection-coverage operation=ownerInspections state=incomplete",
      },
    ]);
    expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(logs)).not.toContain(
      "private platform diagnostic"
    );
    yield* inspect(db);

    yield* Effect.tryPromise(() => installTestSchema({ db }));
    yield* inspect(db);
    yield* inspect(db);
    expect(logs).toContainEqual([
      {
        component: "capability",
        operation: "d1",
        state: "healthy",
        severity: "none",
        message: "fidy.operational component=capability operation=d1 state=healthy severity=none",
      },
    ]);
    expect(logs).toContainEqual([
      {
        component: "inspection-coverage",
        operation: "ownerInspections",
        state: "complete",
        message:
          "fidy.operational component=inspection-coverage operation=ownerInspections state=complete",
      },
    ]);
  })
);
