import { DateTime, Duration, Effect, Schema } from "effect";
import { MachineId, Snowflake } from "effect/unstable/cluster";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { HostedTurns } from "~/shell/agent/hosted-turns";

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
      WHERE entity_type = ${HostedTurns.type} AND kind = 0 AND processed = TRUE AND last_reply_id < ${cutoff.toString()}
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

  /**
   * Removes at most 100 completed identifier-bearing items and reports whether any remain.
   * The caller must hold the producer's domain lock and prove its execution terminal and ineligible
   * for new publication. Incomplete and actively handled items are never removed.
   */
  removeCompletedByPayload: Effect.fn("DurableQueueRetention.removeCompletedByPayload")(function* (
    queueName: string,
    identifierField: string,
    identifier: string
  ) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      DELETE FROM fidy_queue WHERE sequence IN (
        SELECT sequence FROM fidy_queue
        WHERE queue_name = ${queueName} AND element::jsonb ->> ${identifierField} = ${identifier}
          AND completed = TRUE
        ORDER BY sequence LIMIT 100
      )
    `.pipe(Effect.orDie);
    return (yield* SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ empty: Schema.Boolean }),
      execute: () => sql`SELECT NOT EXISTS (
        SELECT 1 FROM fidy_queue
        WHERE queue_name = ${queueName} AND element::jsonb ->> ${identifierField} = ${identifier}
      ) AS empty`,
    })(undefined).pipe(Effect.orDie)).empty;
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

/**
 * Version-local read-only quiescence probe for the foundation's default SQL Cluster namespace.
 * A processed request has committed its final reply; an unfinished or delayed clock/deferred
 * request therefore prevents mailbox deletion. The caller must first fence every application
 * producer and prove the workflow terminal. A memory-engine harness has no SQL mailbox table.
 */
export const durableWorkflowMailboxesTerminal = Effect.fn(
  "DurableWorkflowRetention.mailboxesTerminal"
)(function* (executionId: string, entityTypes: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient;
  const present = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ present: Schema.Boolean }),
    execute: () => sql`SELECT to_regclass('cluster_messages') IS NOT NULL AS present`,
  })(undefined).pipe(Effect.orDie);
  if (!present.present) return true;
  return (yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ terminal: Schema.Boolean }),
    execute: () => sql`SELECT NOT EXISTS (
        SELECT 1 FROM cluster_messages WHERE entity_id = ${executionId}
          AND entity_type IN ${sql.in(entityTypes)} AND processed = FALSE
      ) AS terminal`,
  })(undefined).pipe(Effect.orDie)).terminal;
});
