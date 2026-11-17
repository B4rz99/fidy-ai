import { ErasureReference } from "../../src/core/erasure/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { UserId } from "../../src/core/identity/contract";
import { withStoreAdmission } from "../runtime/sqlite/operations";
import {
  type ScheduledActivity,
  ScheduledWorkFailed,
  fenceLifetimeUrl,
  maintenanceName,
  registerLifetimeUrl,
  retireLifetimeUrl,
} from "./contract";
import type { StoreHistory } from "../runtime/sqlite/contract";
import { Cause, Clock, Data, Effect, Exit, Schema } from "effect";
import { activityDue } from "./internal/cadence";

/**
 * Attempt independent activities in order and report a closed failure only after the last one.
 * Interruption stops the schedule and preserves owner cleanup rather than becoming a work failure.
 * Each owner still decides eligibility and retention; successful scheduling grants no authority.
 */
export const executeSchedule = <E>(
  activities: ReadonlyArray<ScheduledActivity<E>>
): Effect.Effect<void, ScheduledWorkFailed> =>
  Effect.gen(function* () {
    let failed = false;
    for (const { operation, work } of activities) {
      const result = yield* Effect.exit(work.pipe(Effect.withSpan(operation)));
      if (Exit.isFailure(result)) {
        if (Cause.hasInterrupts(result.cause)) return yield* Effect.interrupt;
        failed = true;
        yield* Effect.logWarning({ component: "scheduled-work", operation, outcome: "failed" });
      }
    }
    if (failed) return yield* new ScheduledWorkFailed();
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

/** Immutable Maintenance migrations. */
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
  ],
};

const registeredStatus = 204;
const conflictStatus = 409;
// A delayed register can reach Maintenance only within this window. Erasure may discard the
// retired fence after this and the other original windows have closed and retirement is acknowledged.
const maximumRegistrationAgeMs = 60_000;
class UserRegistrationUnavailable extends Data.TaggedError("UserRegistrationUnavailable") {}

/** Register outside the User transaction, before committing activation or accepting work. */
export const registerUserLifetime = Effect.fn(function* (
  maintenance: Pick<DurableObjectNamespace, "getByName">,
  userId: UserId
) {
  const issuedAt = yield* Clock.currentTimeMillis;
  const response = yield* Effect.tryPromise((signal) =>
    maintenance.getByName(maintenanceName).fetch(registerLifetimeUrl, {
      method: "POST",
      headers: { "fidy-user-id": userId, "fidy-registration-issued-ms": String(issuedAt) },
      signal,
    })
  );
  if (response.status !== registeredStatus) return yield* new UserRegistrationUnavailable();
});

const acknowledgement = (matched: boolean): Response =>
  new Response(null, { status: matched ? registeredStatus : conflictStatus });

export const lifetimeRequest = (request: Request): boolean =>
  request.method === "POST" &&
  [registerLifetimeUrl, fenceLifetimeUrl, retireLifetimeUrl].includes(request.url);

export const handleLifetimeRegistration = Effect.fn(function* (request: Request) {
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
        yield* sql`INSERT INTO lifetime_registry(user_id) VALUES(${userId})`;
        return acknowledgement(true);
      })
    );
  }
  const reference = request.headers.get("fidy-erasure-reference");
  if (!Schema.is(ErasureReference)(reference)) return new Response(null, { status: 400 });
  return yield* withStoreAdmission(() =>
    Effect.gen(function* () {
      const matched =
        request.url === fenceLifetimeUrl
          ? yield* sql`UPDATE lifetime_registry SET erasure_reference=${reference} WHERE user_id=${userId}
          AND (erasure_reference IS NULL OR erasure_reference=${reference}) RETURNING user_id`
          : yield* sql`UPDATE lifetime_registry SET retired=1 WHERE user_id=${userId} AND erasure_reference=${reference} RETURNING user_id`;
      return acknowledgement(matched.length === 1);
    })
  );
});
