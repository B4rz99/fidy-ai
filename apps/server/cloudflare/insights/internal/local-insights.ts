import { maximumPendingInsights, pendingCursor } from "./insight-store";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { DateTime, Effect, Option, Schema } from "effect";
import type { UserId } from "../../../src/core/identity/contract";
import {
  DeliveryAttemptId,
  DeliveryEvidenceInput,
  InsightDeliveryAttempt,
  InsightEvent,
  type InsightEventId,
  ReminderSchedule,
  type ReminderScheduleEdit,
  ScheduleVersion,
} from "../../../src/core/insights/contract";
import {
  allowedInsightTransitions,
  nextReminderOccurrence,
} from "../../../src/core/insights/operations";
import { type LocalMutationResult } from "../../canonical-admission/contract";
import { newId } from "../../secret-material/operations";
import { prepareLocalWrite } from "../../canonical-admission/operations";
import { preserveStoreAlarm } from "../../runtime/sqlite/operations";

const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const eventCodec = Schema.toCodecJson(InsightEvent);

const receiptCodec = Schema.toCodecJson(InsightDeliveryAttempt);

const scheduleCodec = Schema.toCodecJson(ReminderSchedule);

const success = (data: Schema.Json): LocalMutationResult => ({
  status: 200,
  outcome: "success",
  body: { data, next: [] },
});

const missing: LocalMutationResult = {
  status: 404,
  outcome: "not_found",
  body: { error: { code: "not_found", message: "Insight unavailable." }, next: [] },
};

const invalid: LocalMutationResult = {
  status: 400,
  outcome: "validation_failed",
  body: {
    error: { code: "validation_failed", message: "Insight transition unavailable.", fields: [] },
    next: [],
  },
};

type Transition = { id: InsightEventId } & (
  | { target: "delivered"; evidence: DeliveryEvidenceInput }
  | { target: "read" | "dismissed" }
);

export const prepareTransition = Effect.fn(function* (edit: Transition, user: UserId) {
  const sql = yield* SqliteClient;

  const [raw] =
    yield* sql`SELECT event_json,receipt_json FROM insight_events WHERE user_id=${user} AND id=${edit.id}`;

  if (raw === undefined) return missing;

  const held = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      event_json: Schema.fromJsonString(eventCodec),
      receipt_json: Schema.NullOr(Schema.fromJsonString(receiptCodec)),
    })
  )(raw);

  const event = held.event_json;

  if (!allowedInsightTransitions(event.lifecycleState).includes(edit.target)) return invalid;
  const observed = yield* Schema.encodeEffect(eventCodec)(event);

  const receipt =
    held.receipt_json === null ? null : yield* Schema.encodeEffect(receiptCodec)(held.receipt_json);

  const revision = yield* jsonText({ event: observed, receipt });

  const evidence =
    edit.target === "delivered"
      ? yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.toCodecJson(DeliveryEvidenceInput))
        )(edit.evidence)
      : "";

  return prepareLocalWrite({
    targets: [`insight:${edit.id}`],
    review: Effect.succeed({
      revision,
      effect: `Cambiar el InsightEvent ${edit.id} de ${event.lifecycleState} a ${edit.target}. Evento y entrega: ${revision}. Evidencia: ${evidence}`,
    }),
    commit: Effect.gen(function* () {
      const insight = yield* Schema.encodeEffect(eventCodec)({
        ...event,
        lifecycleState: edit.target,
      });

      const deliveryAttempt =
        edit.target === "delivered"
          ? yield* Schema.encodeEffect(receiptCodec)({
              id: DeliveryAttemptId.make(newId()),
              insightEventId: edit.id,
              ...edit.evidence,
            })
          : null;

      const updated =
        yield* sql`UPDATE insight_events SET event_json=${yield* jsonText(insight)},receipt_json=coalesce(${deliveryAttempt === null ? null : yield* jsonText(deliveryAttempt)},receipt_json)
        WHERE user_id=${user} AND id=${edit.id} AND json_extract(event_json,'$.lifecycleState')=${event.lifecycleState} RETURNING id`;

      if (updated.length !== 1) return invalid;

      return success(deliveryAttempt === null ? insight : { insight, deliveryAttempt });
    }),
  });
});

const heldSchedule = Effect.fn(function* (user: UserId) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT snapshot_json,grant_id,revision,id FROM reminder_schedules WHERE user_id=${user}`;

  if (row === undefined) return Option.none();

  const snapshot = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      snapshot_json: Schema.fromJsonString(scheduleCodec),
      grant_id: Schema.String,
      revision: Schema.Int,
      id: Schema.String,
    })
  )(row);

  if (
    snapshot.snapshot_json.id !== snapshot.id ||
    snapshot.snapshot_json.version !== snapshot.revision
  ) {
    return yield* Effect.fail("inconsistent_reminder");
  }

  return Option.some(snapshot);
});

export const readSchedule = Effect.fn(function* (user: UserId) {
  const held = yield* heldSchedule(user);

  return success(
    Option.isNone(held) ? null : yield* Schema.encodeEffect(scheduleCodec)(held.value.snapshot_json)
  );
});

export const prepareSchedule = Effect.fn(function* (
  edit: ReminderScheduleEdit,
  { user, current, storage }: { user: UserId; current: number; storage: DurableObjectStorage }
) {
  const held = yield* heldSchedule(user);

  if (Option.isNone(held)) return missing;
  const old = held.value.snapshot_json;

  if (old.version !== edit.expectedVersion) return invalid;
  const sql = yield* SqliteClient;

  const updated = ReminderSchedule.make({
    ...old,
    cadence: edit.cadence,
    timing: edit.timing,
    timeZone: edit.timeZone,
    version: ScheduleVersion.make(old.version + 1),
    nextScheduledAt: nextReminderOccurrence({ ...edit, after: DateTime.makeUnsafe(current) }),
  });

  const snapshot = yield* Schema.encodeEffect(scheduleCodec)(updated);
  const snapshotText = yield* jsonText(snapshot);
  const original = yield* Schema.encodeEffect(scheduleCodec)(old);

  return prepareLocalWrite({
    targets: [`reminder:${old.id}`],
    review: Effect.succeed({
      revision: yield* jsonText(original),
      effect: `Actualizar el horario de recordatorio: ${snapshotText}`,
    }),
    commit: Effect.gen(function* () {
      const changed =
        yield* sql`UPDATE reminder_schedules SET revision=${updated.version},snapshot_json=${snapshotText},next_at_ms=${updated.nextScheduledAt.epochMilliseconds}
        WHERE user_id=${user} AND id=${old.id} AND revision=${old.version} AND grant_id=${held.value.grant_id}
        AND EXISTS(SELECT 1 FROM proactive_grants WHERE user_id=${user} AND id=${held.value.grant_id} AND kind='manual-entry-reminder' AND revoked_at_ms IS NULL) RETURNING id`;

      if (changed.length !== 1) return invalid;
      yield* sql`INSERT INTO reminder_revisions VALUES(${old.id},${updated.version},${snapshotText})`;

      if (updated.enabled) {
        yield* preserveStoreAlarm(storage, updated.nextScheduledAt.epochMilliseconds);
      }

      return success(snapshot);
    }),
  });
});

export const pendingInsights = Effect.fn(function* (request: Request, user: UserId, now: number) {
  const url = new URL(request.url),
    cursor = pendingCursor(url);

  if (Option.isNone(cursor)) return { result: invalid, next: Option.none<string>() };

  const sql = yield* SqliteClient,
    at = Option.getOrNull(cursor.value.scheduledAt);

  const raw =
    yield* sql`SELECT event_json FROM insight_events WHERE user_id=${user} AND json_extract(event_json,'$.lifecycleState')='pending' AND scheduled_ms<=${now} AND (${at} IS NULL OR (scheduled_ms,id)>(${at},${cursor.value.id})) ORDER BY scheduled_ms,id LIMIT ${maximumPendingInsights + 1}`;

  const events = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ event_json: Schema.fromJsonString(eventCodec) }))
  )(raw.slice(0, maximumPendingInsights));

  const last = events.at(-1);

  if (last !== undefined) {
    url.searchParams.set(
      "cursor",
      DateTime.formatIso(last.event_json.scheduledAt) + "|" + last.event_json.id
    );
  }

  const data = yield* Schema.encodeEffect(Schema.Array(eventCodec))(
    events.map((row) => row.event_json)
  );

  return {
    result: success([...data]),
    next: raw.length > maximumPendingInsights ? Option.some(url.toString()) : Option.none<string>(),
  };
});
