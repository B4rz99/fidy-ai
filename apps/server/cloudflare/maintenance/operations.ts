import { confirmLifetimeCaseUrl } from "../erasure-store/contract";
import { type ErasureRegistryNamespace, erasureRegistryName } from "../erasure/contract";
import { ErasureReference } from "../../src/core/erasure/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { UserId } from "../../src/core/identity/contract";
import { withStoreAdmission } from "../runtime/sqlite/operations";
import {
  type ScheduledActivity,
  ScheduledWorkFailed,
  expireLifetimeUrl,
  fenceLifetimeUrl,
  registerLifetimeUrl,
  registrationAcceptedStatus,
  retireLifetimeUrl,
} from "./contract";
import type { StoreHistory } from "../runtime/sqlite/contract";
import { Cause, Clock, Effect, Exit, Option, Schema } from "effect";
import { activityDue } from "./internal/cadence";

export const executeSchedule = <E>(
  activities: ReadonlyArray<ScheduledActivity<E>>
): Effect.Effect<void, ScheduledWorkFailed> =>
  Effect.gen(function* () {
    const failed = yield* Effect.reduce(
      activities,
      () => false,
      (anyFailed, { operation, work }) =>
        Effect.exit(work.pipe(Effect.withSpan(operation))).pipe(
          Effect.flatMap((result) => {
            if (Exit.isSuccess(result)) return Effect.succeed(anyFailed);

            if (Cause.hasInterrupts(result.cause)) return Effect.interrupt;

            return Effect.logWarning({
              component: "scheduled-work",
              operation,
              outcome: "failed",
            }).pipe(Effect.as(true));
          })
        )
    );

    if (failed) return yield* new ScheduledWorkFailed({ cause: Option.none() });
  });

export const executeDueSchedule = <E>(
  input: Readonly<{
    activities: ReadonlyArray<ScheduledActivity<E>>;
    nowEpochMs: number;
  }>
): Effect.Effect<void, ScheduledWorkFailed> =>
  executeSchedule(
    input.activities.filter(({ operation }) =>
      activityDue({ operation, nowEpochMs: input.nowEpochMs })
    )
  );

export const maintenanceStoreHistory: StoreHistory = {
  owner: "maintenance",
  steps: [
    { version: 1, id: "initial-maintenance-store", statements: [] },
    {
      version: 2,
      id: "user-lifetime-registry",
      statements: [
        "CREATE TABLE lifetime_registry(user_id TEXT PRIMARY KEY NOT NULL, erasure_reference TEXT, retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1) AND (retired=0 OR erasure_reference IS NOT NULL))) STRICT",
        "CREATE INDEX discoverable_users ON lifetime_registry(user_id) WHERE retired=0",
      ],
    },
    {
      version: 3,
      id: "watchdog-traversal",
      statements: [
        `CREATE TABLE watchdog_progress (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), minute INTEGER NOT NULL DEFAULT -1,
          scheduled INTEGER NOT NULL DEFAULT -1, cursor TEXT NOT NULL DEFAULT '', halt TEXT NOT NULL DEFAULT 'idle',
          wraps INTEGER NOT NULL DEFAULT 0, wrapped_at INTEGER NOT NULL DEFAULT 0, defer_fixed INTEGER NOT NULL DEFAULT 0,
          admitted INTEGER NOT NULL DEFAULT 0, attempted INTEGER NOT NULL DEFAULT 0, observed INTEGER NOT NULL DEFAULT 0,
          failed INTEGER NOT NULL DEFAULT 0, unsupported INTEGER NOT NULL DEFAULT 0, unknown INTEGER NOT NULL DEFAULT 0, repaired INTEGER NOT NULL DEFAULT 0
        ) STRICT`,
        "INSERT INTO watchdog_progress(singleton) VALUES(1)",
      ],
    },
    {
      version: 4,
      id: "watchdog-observation-age",
      statements: [
        "ALTER TABLE watchdog_progress ADD COLUMN started_ms INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE watchdog_progress ADD COLUMN last_attempt_ms INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE watchdog_progress ADD COLUMN last_observed_ms INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE lifetime_registry ADD COLUMN registered_ms INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE lifetime_registry ADD COLUMN observed_ms INTEGER NOT NULL DEFAULT 0",
        "CREATE INDEX lifetime_observation_age ON lifetime_registry(max(observed_ms,registered_ms)) WHERE retired=0",
        "CREATE INDEX lifetime_schema_unobserved ON lifetime_registry(user_id) WHERE retired=0 AND observed_ms=0",
        "ALTER TABLE watchdog_progress ADD COLUMN shared_observed INTEGER NOT NULL DEFAULT 0",
      ],
    },
    {
      version: 5,
      id: "bounded-workflow-observation",
      statements: [
        "ALTER TABLE watchdog_progress ADD COLUMN sample_cursor TEXT NOT NULL DEFAULT ''",
      ],
    },
  ],
};

const conflictStatus = 409;

const maximumRegistrationAgeMs = 60_000;

const acknowledgement = (matched: boolean): Response =>
  new Response(null, { status: matched ? registrationAcceptedStatus : conflictStatus });

export const lifetimeRequest = (request: Request): boolean =>
  request.method === "POST" &&
  [registerLifetimeUrl, fenceLifetimeUrl, retireLifetimeUrl, expireLifetimeUrl].includes(
    request.url
  );

export const handleLifetimeRegistration = Effect.fn(function* (
  request: Request,
  erasure: Option.Option<ErasureRegistryNamespace>
) {
  const userId = request.headers.get("fidy-user-id");

  if (!Schema.is(UserId)(userId)) return new Response(null, { status: 400 });
  const sql = yield* SqliteClient;

  if (request.url === registerLifetimeUrl) {
    return yield* withStoreAdmission((admitGrowth) =>
      Effect.gen(function* () {
        const issuedAt = Number(request.headers.get("fidy-registration-issued-ms"));
        const age = (yield* Clock.currentTimeMillis) - issuedAt;

        if (!Number.isSafeInteger(issuedAt) || age < 0 || age >= maximumRegistrationAgeMs) {
          return acknowledgement(false);
        }

        const [entry] =
          yield* sql`SELECT erasure_reference IS NULL AS live FROM lifetime_registry WHERE user_id=${userId}`;

        if (entry !== undefined) {
          const state = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ live: Schema.Literals([0, 1]) })
          )(entry);

          return acknowledgement(state.live === 1);
        }

        yield* admitGrowth;
        yield* sql`INSERT INTO lifetime_registry(user_id,registered_ms) VALUES(${userId},${issuedAt})`;

        return acknowledgement(true);
      })
    );
  }

  return yield* changeLifetime(request, userId, erasure);
});

const changeLifetime = Effect.fn(function* (
  request: Request,
  userId: string,
  erasure: Option.Option<ErasureRegistryNamespace>
) {
  const sql = yield* SqliteClient;
  const reference = request.headers.get("fidy-erasure-reference");

  if (!Schema.is(ErasureReference)(reference)) return new Response(null, { status: 400 });

  if (Option.isNone(erasure)) return acknowledgement(false);

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    userId,
    reference,
    action: {
      [fenceLifetimeUrl]: "fence",
      [retireLifetimeUrl]: "retire",
      [expireLifetimeUrl]: "expire",
    }[request.url],
  });

  const verified = yield* Effect.tryPromise((signal) =>
    erasure.value
      .getByName(erasureRegistryName)
      .fetch(confirmLifetimeCaseUrl, { method: "POST", body, signal })
  ).pipe(Effect.timeout("5 seconds"));

  if (verified.status !== registrationAcceptedStatus) return acknowledgement(false);

  return yield* withStoreAdmission(() =>
    Effect.gen(function* () {
      if (request.url === expireLifetimeUrl) {
        yield* sql`DELETE FROM lifetime_registry WHERE user_id=${userId} AND erasure_reference=${reference} AND retired=1`;

        return acknowledgement(
          (yield* sql`SELECT 1 FROM lifetime_registry WHERE user_id=${userId}`).length === 0
        );
      }

      const matched =
        request.url === fenceLifetimeUrl
          ? yield* sql`UPDATE lifetime_registry SET erasure_reference=${reference} WHERE user_id=${userId}
          AND (erasure_reference IS NULL OR erasure_reference=${reference}) RETURNING user_id`
          : yield* sql`UPDATE lifetime_registry SET retired=1 WHERE user_id=${userId} AND erasure_reference=${reference} RETURNING user_id`;

      return acknowledgement(matched.length === 1);
    })
  );
});
