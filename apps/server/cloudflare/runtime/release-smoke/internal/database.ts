import { Data, Effect } from "effect";
import { SmokeBindingFailed, platform } from "./platform";

class SmokeRollbackFailed extends Data.TaggedError("SmokeRollbackFailed")<{ cause: unknown }> {}

const expectedRollbackMessages = new Set([
  "CHECK constraint failed: fidy_smoke_rollback_v1",
  "CHECK constraint failed: fidy_smoke_rollback_v1: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)",
  "D1_ERROR: CHECK constraint failed: fidy_smoke_rollback_v1: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)",
  "D1_ERROR: CHECK constraint failed: fidy_smoke_rollback_v1",
  "D1_ERROR: CHECK constraint failed: fidy_smoke_rollback_v1: SQLITE_CONSTRAINT",
]);
const expectedRollback = (cause: unknown, depth = 0): boolean =>
  cause instanceof Error &&
  depth < 4 &&
  (expectedRollbackMessages.has(cause.message) || expectedRollback(cause.cause, depth + 1));

/** A named failure after a real write must roll back the entire native batch, including DDL. */
export const verifySmokeDatabase = (db: D1Database): Effect.Effect<void, SmokeBindingFailed> =>
  Effect.gen(function* () {
    const outcome = yield* Effect.tryPromise({
      try: () =>
        db.batch([
          db.prepare(
            "CREATE TABLE fidy_release_verification(value INTEGER NOT NULL CONSTRAINT fidy_smoke_rollback_v1 CHECK(value=1)) STRICT"
          ),
          db.prepare("INSERT INTO fidy_release_verification(value) VALUES(1)"),
          db.prepare("INSERT INTO fidy_release_verification(value) VALUES(0)"),
        ]),
      catch: (cause) => new SmokeRollbackFailed({ cause }),
    }).pipe(Effect.result);
    if (outcome._tag === "Success") return yield* new SmokeBindingFailed({ stage: "schema" });
    if (!expectedRollback(outcome.failure.cause)) {
      return yield* platform({
        stage: "schema",
        tryWork: () => Promise.reject(outcome.failure.cause),
      });
    }
    const remaining = yield* platform({
      stage: "schema",
      tryWork: () =>
        db
          .prepare(
            "SELECT count(*) AS remaining FROM sqlite_schema WHERE name='fidy_release_verification'"
          )
          .first<number>("remaining"),
    });
    if (remaining !== 0) return yield* new SmokeBindingFailed({ stage: "schema" });
  });
