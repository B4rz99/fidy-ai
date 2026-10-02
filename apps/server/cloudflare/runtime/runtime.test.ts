import { deepStrictEqual } from "node:assert";
import { it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import { afterAll, expect } from "vitest";
import { isolatedTestStorage } from "../d1-test-fixture";
import { type PlatformMaintenanceInput, PlatformMaintenanceUnavailable } from "./contract";
import { makePlatformMaintenance } from "./runtime";

const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const unavailable = (): never => {
  throw new Error("private platform diagnostic");
};
const queue: Queue = { send: unavailable, sendBatch: unavailable, metrics: unavailable };
const workflow: Workflow = {
  create: unavailable,
  get: unavailable,
  createBatch: unavailable,
  deleteBatch: unavailable,
};
const input = (
  db: D1Database,
  overrides: Partial<PlatformMaintenanceInput> = {}
): PlatformMaintenanceInput => ({
  DB: db,
  USER_TRANSACTION_COORDINATOR: { getByName: unavailable },
  AI: { run: unavailable },
  RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  KAPSO_API_KEY: "configured",
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
  ONBOARDING_EMAIL_QUEUE: Option.none(),
  BROWSER_PAIRING_EMAIL_QUEUE: Option.none(),
  EMAIL_REPLACEMENT_QUEUE: Option.none(),
  BILLING_COLLECTION_QUEUE: Option.none(),
  STATEMENT_EXTRACTION_QUEUE: Option.none(),
  HOSTED_WHATSAPP_QUEUE: Option.none(),
  ONBOARDING_EMAIL_WORKFLOW: Option.none(),
  BROWSER_PAIRING_EMAIL_WORKFLOW: Option.none(),
  EMAIL_REPLACEMENT_WORKFLOW: Option.none(),
  BILLING_COLLECTION_WORKFLOW: Option.none(),
  STATEMENT_EXTRACTION_WORKFLOW: Option.none(),
  OPERATOR_ALERT_EMAIL: Option.none(),
  RESEND_API_KEY: Option.none(),
  WOMPI_EVENT_SECRET: Option.none(),
  SMOKE_BUCKET: Option.none(),
  SMOKE_QUEUE: Option.none(),
  SMOKE_WORKFLOW: Option.none(),
  SMOKE_QUEUE_NAME: Option.none(),
  SMOKE_PROOF: Option.none(),
  CF_VERSION_METADATA: Option.none(),
  ...overrides,
});

it.effect("keeps disabled operational work inert but refuses an enabled missing canary Queue", () =>
  Effect.gen(function* () {
    const { db } = yield* Effect.tryPromise(() => storage.acquire());
    const disabled = makePlatformMaintenance(input(db));
    yield* disabled.inspectHealth();
    yield* disabled.retainEventBuckets(600_000);
    yield* disabled.publishCanary(600_000);
    yield* disabled.expireSmokeProbes(600_000);
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

it.effect("expires only older smoke probes when every required smoke binding is present", () =>
  Effect.gen(function* () {
    const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
    yield* Effect.tryPromise(() =>
      db.prepare("CREATE TABLE release_smoke_probes (probe_id TEXT, expires_at_ms INTEGER)").run()
    );
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          "INSERT INTO release_smoke_probes VALUES ('expired', 99), ('boundary', 100), ('fresh', 101)"
        )
        .run()
    );
    const configured = input(db, {
      SMOKE_BUCKET: Option.some(bucket),
      SMOKE_QUEUE: Option.some(queue),
      SMOKE_WORKFLOW: Option.some(workflow),
      SMOKE_QUEUE_NAME: Option.some(""),
      SMOKE_PROOF: Option.some(""),
      CF_VERSION_METADATA: Option.some({ id: "" }),
    });
    yield* makePlatformMaintenance({
      ...configured,
      CF_VERSION_METADATA: Option.none(),
    }).expireSmokeProbes(100);
    expect(
      yield* Effect.tryPromise(() =>
        db.prepare("SELECT COUNT(*) AS count FROM release_smoke_probes").first()
      )
    ).toEqual({ count: 3 });
    yield* makePlatformMaintenance(configured).expireSmokeProbes(100);
    expect(
      yield* Effect.tryPromise(() =>
        db.prepare("SELECT probe_id FROM release_smoke_probes ORDER BY probe_id").all()
      )
    ).toMatchObject({ results: [{ probe_id: "boundary" }, { probe_id: "fresh" }] });
    yield* Effect.tryPromise(() => db.prepare("DROP TABLE release_smoke_probes").run());
    deepStrictEqual(
      yield* Effect.exit(makePlatformMaintenance(configured).expireSmokeProbes(100)),
      Exit.fail(new PlatformMaintenanceUnavailable())
    );
  })
);

it.effect(
  "records unavailable measurements and readiness even when alert configuration is absent",
  () =>
    Effect.gen(function* () {
      const { db } = yield* Effect.tryPromise(() => storage.acquire());
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TABLE operational_health_view (operation TEXT PRIMARY KEY, state TEXT, observed_at_ms INTEGER)"
          )
          .run()
      );
      const configured = input(db, {
        ASYNC_HEALTH_ENABLED: Option.some("enabled"),
        RESEND_API_KEY: Option.some("configured"),
        WOMPI_EVENT_SECRET: Option.some("configured"),
        USER_TRANSACTION_COORDINATOR: {
          getByName: () => ({
            fetch: (): Promise<Response> => Promise.resolve(new Response(null, { status: 204 })),
          }),
        },
      });
      deepStrictEqual(
        yield* Effect.exit(makePlatformMaintenance(configured).inspectHealth()),
        Exit.fail(new PlatformMaintenanceUnavailable())
      );
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT operation, state FROM operational_health_view WHERE operation IN ('d1', 'coordination', 'providerConfig', 'requiredBindings', 'queueExecution', 'workflowFailures') ORDER BY operation"
            )
            .all()
        )
      ).toMatchObject({
        results: [
          { operation: "coordination", state: "healthy" },
          { operation: "d1", state: "healthy" },
          { operation: "providerConfig", state: "healthy" },
          { operation: "queueExecution", state: "unavailable" },
          { operation: "requiredBindings", state: "unavailable" },
          { operation: "workflowFailures", state: "unavailable" },
        ],
      });
      yield* Effect.exit(
        makePlatformMaintenance({
          ...configured,
          RESEND_API_KEY: Option.some("  "),
        }).inspectHealth()
      );
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare("SELECT state FROM operational_health_view WHERE operation = 'providerConfig'")
            .first()
        )
      ).toEqual({ state: "unavailable" });
    })
);
