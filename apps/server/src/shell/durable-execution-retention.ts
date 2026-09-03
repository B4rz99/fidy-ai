import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

const QueueCompletionRows = Schema.Array(
  Schema.Struct({ incomplete: Schema.Finite, requiredCompleted: Schema.Finite })
);

/** Version-local SQL queue cleanup used only after domain state proves execution terminal. */
export const durableQueueRetention = {
  completed: Effect.fn("DurableQueueRetention.completed")(function* (
    queueName: string,
    itemIds: ReadonlyArray<string>,
    requiredItemIds: ReadonlyArray<string>
  ) {
    if (itemIds.length === 0) return true;
    const sql = yield* SqlClient.SqlClient;
    const [state] =
      requiredItemIds.length === 0
        ? yield* Schema.decodeUnknownEffect(QueueCompletionRows)(
            yield* sql`SELECT count(*) FILTER (WHERE completed = FALSE)::int AS incomplete,
                0::int AS "requiredCompleted"
              FROM fidy_queue
              WHERE queue_name = ${queueName} AND id IN ${sql.in(itemIds)}`
          ).pipe(Effect.orDie)
        : yield* Schema.decodeUnknownEffect(QueueCompletionRows)(
            yield* sql`SELECT
                count(*) FILTER (WHERE completed = FALSE)::int AS incomplete,
                count(*) FILTER (
                  WHERE completed = TRUE AND id IN ${sql.in(requiredItemIds)}
                )::int AS "requiredCompleted"
              FROM fidy_queue
              WHERE queue_name = ${queueName} AND id IN ${sql.in(itemIds)}`
          ).pipe(Effect.orDie);
    return state?.incomplete === 0 && state.requiredCompleted === requiredItemIds.length;
  }),

  removeCompleted: Effect.fn("DurableQueueRetention.removeCompleted")(function* (
    queueName: string,
    itemIds: ReadonlyArray<string>
  ) {
    if (itemIds.length === 0) return;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      DELETE FROM fidy_queue
      WHERE queue_name = ${queueName} AND completed = TRUE AND id IN ${sql.in(itemIds)}
    `;
  }),
};
