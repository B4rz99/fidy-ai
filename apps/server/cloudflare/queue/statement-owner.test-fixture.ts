import { Clock, Effect, Schema } from "effect";
import type { CoreQueueEnvironment } from "./contract";
import { StatementWork } from "../ingestion/contract";

/** Queue transport fixture. The signed-ingress journeys exercise the real User SQLite owner. */
const unavailableStatus = 404,
  availableStatus = 200;
export const statementOwner = (
  db: D1Database
): NonNullable<CoreQueueEnvironment["USER_STORE"]> => ({
  getByName: (owner) => ({
    fetch: (input, init) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const request = new Request(input, init);
          const unit = yield* Schema.decodeUnknownEffect(StatementWork)(
            yield* Effect.tryPromise(() => request.json())
          );
          const now = yield* Clock.currentTimeMillis;
          const active = yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT 1 FROM statement_submissions WHERE id=? AND user_id=? AND status='queued' AND retention_expires_at_ms>?"
              )
              .bind(unit.submissionId, owner, now)
              .first()
          );
          return new Response(null, {
            status: active === null ? unavailableStatus : availableStatus,
          });
        })
      ),
  }),
});
