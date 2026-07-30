import { DateTime, Effect, Schema, SchemaTransformation, Struct } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { encodeMoneyAmount } from "~/core/_shared/money";
import { UserId } from "~/core/_shared/user";
import {
  DeliveryEvidenceInput,
  InsightDeliveryAttempt,
  InsightEvent,
  InsightEventId,
  InsightGenerationInput,
  InsightMoneyGroups,
} from "~/core/insights/model";

const EventRowFields = InsightEvent.mapFields(Struct.omit(["id", "scheduledAt", "moneyGroups"]));

const InsightEventRow = Schema.Struct({
  id: Schema.toEncoded(InsightEvent.fields.id),
  ...EventRowFields.fields,
  scheduleId: Schema.toEncoded(InsightEvent.fields.scheduleId),
  scheduleVersion: Schema.toEncoded(InsightEvent.fields.scheduleVersion),
  timeZone: Schema.toEncoded(InsightEvent.fields.timeZone),
  scheduledAt: Schema.DateTimeUtcFromDate,
  moneyGroups: Schema.toEncoded(InsightMoneyGroups),
});

/** PostgreSQL dates and JSON Money text decoded back into the canonical model. */
const InsightEventFromRow = InsightEventRow.pipe(
  Schema.decodeTo(
    InsightEvent,
    SchemaTransformation.transform({
      decode: ({ scheduledAt, ...row }) => ({
        ...row,
        scheduledAt: DateTime.formatIso(scheduledAt),
      }),
      encode: ({ scheduledAt, ...event }) => ({
        ...event,
        scheduledAt: DateTime.makeUnsafe(scheduledAt),
      }),
    })
  )
);

const EventInsertRow = Schema.Struct({
  ...InsightGenerationInput.fields,
  userId: UserId,
});

const InsightTransition = InsightEvent.mapFields(Struct.pick(["id", "lifecycleState"]));

const DeliveryAttemptRow = Schema.Struct({
  id: Schema.toEncoded(InsightDeliveryAttempt.fields.id),
  insightEventId: Schema.toEncoded(InsightDeliveryAttempt.fields.insightEventId),
  sentAt: Schema.DateTimeUtcFromDate,
  channel: InsightDeliveryAttempt.fields.channel,
  provider: InsightDeliveryAttempt.fields.provider,
  providerMessageId: InsightDeliveryAttempt.fields.providerMessageId,
});

const DeliveryFromRow = DeliveryAttemptRow.pipe(
  Schema.decodeTo(
    InsightDeliveryAttempt,
    SchemaTransformation.transform({
      decode: ({ sentAt, ...row }) => ({ ...row, sentAt: DateTime.formatIso(sentAt) }),
      encode: ({ sentAt, ...attempt }) => ({
        ...attempt,
        sentAt: DateTime.makeUnsafe(sentAt),
      }),
    })
  )
);

const AppendDeliveryAttempt = Schema.Struct({
  ...DeliveryEvidenceInput.fields,
  insightEventId: InsightEventId,
});

const insightScalarColumns = `id, kind, schedule_id AS "scheduleId",
  schedule_version AS "scheduleVersion", service_market AS "serviceMarket",
  locale, time_zone AS "timeZone", scheduled_at AS "scheduledAt",
  lifecycle_state AS "lifecycleState"`;

const insightColumns = `${insightScalarColumns}, COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'currency', groups.currency,
      'inflow', jsonb_build_object(
        'amount', groups.inflow_amount::text,
        'currency', groups.currency
      ),
      'outflow', jsonb_build_object(
        'amount', groups.outflow_amount::text,
        'currency', groups.currency
      )
    ) ORDER BY groups.currency)
    FROM insight_money_groups AS groups
    WHERE groups.insight_event_id = insight_events.id
  ), '[]'::jsonb) AS "moneyGroups"`;

/**
 * The insights slice's trusted generation door. Future schedulers supply the
 * already-decided occurrence; ownership remains operation context rather than payload.
 */
export const generateInsightEvent = Effect.fn("generateInsightEvent")(function* (
  userId: UserId,
  input: InsightGenerationInput
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const event = yield* SqlSchema.findOne({
          Request: EventInsertRow,
          Result: InsightEventFromRow,
          execute: (row) => sql`
            INSERT INTO insight_events (
              user_id, kind, schedule_id, schedule_version, service_market,
              locale, time_zone, scheduled_at
            ) VALUES (
              ${row.userId}, ${row.kind}, ${row.scheduleId}, ${row.scheduleVersion},
              ${row.serviceMarket}, ${row.locale}, ${row.timeZone}, ${row.scheduledAt}
            )
            RETURNING ${sql.literal(insightScalarColumns)}, '[]'::jsonb AS "moneyGroups"
          `,
        })({ ...input, userId });

        yield* Effect.forEach(
          input.moneyGroups,
          (group) =>
            sql`
            INSERT INTO insight_money_groups (
              insight_event_id, currency, inflow_amount, outflow_amount
            ) VALUES (
              ${event.id}, ${group.currency}, ${encodeMoneyAmount(group.inflow.amount)},
              ${encodeMoneyAmount(group.outflow.amount)}
            )
          `
        );

        return { ...event, moneyGroups: input.moneyGroups };
      })
    )
    .pipe(Effect.orDie);
});

/** Lists only pending occurrences owned by one User, oldest scheduled first. */
export const listPendingInsights = (userId: UserId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findAll({
      Request: UserId,
      Result: InsightEventFromRow,
      execute: (owner) => sql`
        SELECT ${sql.literal(insightColumns)}
        FROM insight_events
        WHERE user_id = ${owner} AND lifecycle_state = 'pending'
        ORDER BY scheduled_at, id
      `,
    })(userId)
  ).pipe(Effect.orDie);

/** Locks one owned occurrence while a handler decides and persists its next state. */
export const lockInsightEvent = Effect.fn("lockInsightEvent")(function* (
  userId: UserId,
  insightEventId: InsightEventId
) {
  return yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: InsightEventId,
      Result: InsightEventFromRow,
      execute: (id) => sql`
        SELECT ${sql.literal(insightColumns)}
        FROM insight_events
        WHERE id = ${id} AND user_id = ${userId}
        FOR UPDATE
      `,
    })(insightEventId)
  ).pipe(Effect.orDie);
});

/**
 * Requires the caller to hold this owned occurrence's row lock in the current transaction.
 * InsightEvents have no delete path, so a missing update result is a persistence defect.
 */
export const updateInsightState = Effect.fn("updateInsightState")(function* (
  userId: UserId,
  transition: typeof InsightTransition.Type
) {
  return yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOne({
      Request: InsightTransition,
      Result: InsightEventFromRow,
      execute: (request) => sql`
        UPDATE insight_events
        SET lifecycle_state = ${request.lifecycleState}
        WHERE id = ${request.id} AND user_id = ${userId}
        RETURNING ${sql.literal(insightColumns)}
      `,
    })(transition)
  ).pipe(Effect.orDie);
});

/**
 * Requires the caller to hold the owned occurrence's row lock and to have accepted its
 * pending-to-delivered movement in the current transaction. Those guarantees make ownership,
 * row presence, and the single-record constraint unconditional; violating them is a defect.
 */
export const appendDeliveryAttempt = Effect.fn("appendDeliveryAttempt")(function* (
  userId: UserId,
  insightEventId: InsightEventId,
  input: DeliveryEvidenceInput
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOne({
    Request: AppendDeliveryAttempt,
    Result: DeliveryFromRow,
    execute: (request) => sql`
      INSERT INTO insight_delivery_attempts (
        insight_event_id, sent_at, channel, provider, provider_message_id
      )
      SELECT ${request.insightEventId}, ${request.sentAt}, ${request.channel},
        ${request.provider}, ${request.providerMessageId}
      FROM insight_events
      WHERE id = ${request.insightEventId} AND user_id = ${userId}
      RETURNING id, insight_event_id AS "insightEventId", sent_at AS "sentAt",
        channel, provider, provider_message_id AS "providerMessageId"
    `,
  })({ ...input, insightEventId }).pipe(Effect.orDie);
});
