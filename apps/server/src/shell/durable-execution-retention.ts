import { DateTime, Duration, Effect, Schema } from "effect";
import { MachineId, Snowflake } from "effect/unstable/cluster";
import { SqlClient } from "effect/unstable/sql";

/**
 * Version-local RC.112 mailbox cleanup: only completed HostedTurns requests and their unit replies.
 * The final reply's Snowflake supplies completion time. Active/unfinished requests are never pruned;
 * durable Turn/claim guards still prevent effect replay after the 24-hour transport-dedup window.
 */
export const pruneCompletedHostedTurnMessages = Effect.fn("DurableExecutionRetention.hostedTurns")(
  function* (now: DateTime.Utc) {
    const sql = yield* SqlClient.SqlClient;
    const [tables] = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ available: Schema.Boolean }))
    )(yield* sql`SELECT to_regclass('fidy_durable.cluster_messages') IS NOT NULL AS available`);
    if (tables?.available !== true) return;
    const cutoff = Snowflake.make({
      machineId: MachineId.make(0),
      sequence: 0,
      timestamp: DateTime.toEpochMillis(now) - Duration.toMillis(Duration.days(1)),
    });
    yield* sql`
    WITH eligible AS MATERIALIZED (
      SELECT request_id FROM fidy_durable.cluster_messages
      WHERE entity_type = 'HostedTurns' AND kind = 0 AND processed = TRUE AND last_reply_id < ${cutoff.toString()}
      ORDER BY last_reply_id LIMIT 256 FOR UPDATE SKIP LOCKED
    ), replies AS (
      DELETE FROM fidy_durable.cluster_replies AS reply USING eligible
      WHERE reply.request_id = eligible.request_id
    ) DELETE FROM fidy_durable.cluster_messages AS message USING eligible
      WHERE message.request_id = eligible.request_id
  `;
  },
  Effect.orDie
);

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
