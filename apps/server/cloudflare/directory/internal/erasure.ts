import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Schema } from "effect";
import { cancelProviderHandoff } from "./reservations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";

const pageSize = 8;
const retryMs = 60_000;

/** Reconcile the old destination's durable outcome. A timeout retains the exact reservation and identity hold. */
export const reconcileErasedHandoffs = Effect.fn(function* (
  users: Pick<DurableObjectNamespace, "getByName">
) {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;
  const due = yield* withStoreCapacity("required")(
    sql`UPDATE provider_attempts SET erasure_check_ms=${now + retryMs} WHERE id IN (SELECT id FROM fenced_provider_handoffs WHERE erasure_check_ms<=${now} ORDER BY erasure_check_ms,id LIMIT ${pageSize}) RETURNING id`
  );
  yield* Effect.forEach(
    due,
    (row) =>
      Schema.decodeUnknownEffect(Schema.String)(row.id).pipe(
        Effect.flatMap((id) => cancelProviderHandoff(id, users)),
        Effect.timeout("5 seconds"),
        Effect.result
      ),
    { concurrency: 4, discard: true }
  );
});
