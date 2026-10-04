import { DateTime, Effect, Option, Schema } from "effect";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { type ConsentRecordId } from "../../../src/core/consent/contract";
import { type UserId } from "../../../src/core/identity/contract";
import {
  ScheduleId,
  ScheduleVersion,
  type WeeklyTiming,
} from "../../../src/core/insights/contract";
import { nextWeeklyOccurrence } from "../../../src/core/insights/operations";
import { prepareConsentAction, prepareWeeklyConsentAction } from "../../consent/operations";
import { newId } from "../../secret-material/operations";
import {
  DueWeeklySchedule,
  InsightUnavailable,
  type WeeklyOccurrenceGuard,
  type WeeklyScheduleAdvance,
  WeeklyScheduleSnapshot,
} from "../contract";

const maximumDueSchedules = 64;
const ScheduleRow = Schema.Struct({
  id: ScheduleId,
  user_id: WeeklyScheduleSnapshot.fields.userId,
  version: WeeklyScheduleSnapshot.fields.version,
  enabled: Schema.Literals([0, 1]),
  weekday: Schema.Int,
  hour: Schema.Int,
  minute: Schema.Int,
  time_zone: IanaTimeZone,
  service_market: WeeklyScheduleSnapshot.fields.serviceMarket,
  locale: WeeklyScheduleSnapshot.fields.locale,
  next_scheduled_at: Schema.String,
  consent_grant_id: WeeklyScheduleSnapshot.fields.consentGrantId,
});
const scheduleColumns =
  "id,user_id,version,enabled,weekday,hour,minute,time_zone,service_market,locale,next_scheduled_at,consent_grant_id";
const decodeSchedule = (raw: unknown): Effect.Effect<WeeklyScheduleSnapshot, InsightUnavailable> =>
  Effect.gen(function* () {
    const row = yield* Schema.decodeUnknownEffect(ScheduleRow)(raw);
    return yield* Schema.decodeEffect(Schema.toCodecJson(WeeklyScheduleSnapshot))({
      id: row.id,
      userId: row.user_id,
      version: row.version,
      enabled: row.enabled === 1,
      timing: { weekday: row.weekday, hour: row.hour, minute: row.minute },
      timeZone: row.time_zone,
      serviceMarket: row.service_market,
      locale: row.locale,
      nextScheduledAt: row.next_scheduled_at,
      consentGrantId: row.consent_grant_id,
    });
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const findSchedule = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): Effect.Effect<Option.Option<WeeklyScheduleSnapshot>, InsightUnavailable> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise(() =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: `SELECT ${scheduleColumns} FROM weekly_schedules WHERE user_id = ?`,
          params: [input.userId],
        },
      }).first()
    );
    return row === null ? Option.none() : Option.some(yield* decodeSchedule(row));
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const discoverSchedules = (
  input: Readonly<{ db: D1Database; now: DateTime.Utc }>
): Effect.Effect<ReadonlyArray<DueWeeklySchedule>, InsightUnavailable> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT user_id AS userId,id FROM weekly_schedules WHERE enabled = 1 AND next_scheduled_at <= ? ORDER BY last_evaluated_at_ms,next_scheduled_at,id LIMIT 64"
        )
        .bind(DateTime.formatIso(input.now))
        .all()
    );
    return yield* Schema.decodeUnknownEffect(
      Schema.Array(DueWeeklySchedule).check(Schema.isMaxLength(maximumDueSchedules))
    )(rows.results);
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const noteScheduleEvaluation = (
  input: Readonly<{ db: D1Database; userId: UserId; id: ScheduleId; now: DateTime.Utc }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.tryPromise(() =>
    input.db
      .prepare(
        "UPDATE weekly_schedules SET last_evaluated_at_ms = ? WHERE user_id = ? AND id = ? AND enabled = 1"
      )
      .bind(input.now.epochMilliseconds, input.userId, input.id)
      .run()
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new InsightUnavailable())
  );

export const occurrenceGuard = (input: WeeklyOccurrenceGuard): D1PreparedStatement => {
  const snapshot = input.snapshot;
  return prepareWeeklyConsentAction({
    db: input.db,
    userId: snapshot.userId,
    grantId: snapshot.consentGrantId,
    statement: {
      sql: `${input.statement.sql} AND EXISTS (SELECT 1 FROM weekly_schedules WHERE user_id = ? AND id = ? AND version = ? AND enabled = 1 AND next_scheduled_at = ? AND next_scheduled_at <= ? AND consent_grant_id = ?)`,
      params: [
        ...input.statement.params,
        snapshot.userId,
        snapshot.id,
        snapshot.version,
        DateTime.formatIso(snapshot.nextScheduledAt),
        DateTime.formatIso(input.now),
        snapshot.consentGrantId,
      ],
    },
  });
};
const scheduleAssertion = (db: D1Database): D1PreparedStatement =>
  db.prepare(
    "INSERT INTO weekly_schedule_assertion (id,accepted) VALUES (1,CASE WHEN changes() = 1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted"
  );

export const scheduleAdvance = (
  input: WeeklyScheduleAdvance
): ReadonlyArray<D1PreparedStatement> => {
  const { snapshot, db, now, materializedScheduledAt } = input;
  if (
    materializedScheduledAt.epochMilliseconds < snapshot.nextScheduledAt.epochMilliseconds ||
    materializedScheduledAt.epochMilliseconds > now.epochMilliseconds
  ) {
    throw new Error("Invalid weekly execution cutoff");
  }
  const next = nextWeeklyOccurrence({
    after: now,
    timing: snapshot.timing,
    timeZone: snapshot.timeZone,
  });
  const marker = occurrenceGuard({
    ...input,
    statement: {
      sql: "INSERT INTO weekly_schedule_executions (user_id,schedule_id,schedule_version,scheduled_at,outcome) SELECT ?,?,?,?,? WHERE 1 = 1",
      params: [
        snapshot.userId,
        snapshot.id,
        snapshot.version,
        DateTime.formatIso(materializedScheduledAt),
        input.outcome,
      ],
    },
  });
  const advance = occurrenceGuard({
    ...input,
    statement: {
      sql: "UPDATE weekly_schedules SET next_scheduled_at = ? WHERE user_id = ? AND id = ?",
      params: [DateTime.formatIso(next), snapshot.userId, snapshot.id],
    },
  });
  return [marker, scheduleAssertion(db), advance, scheduleAssertion(db)];
};

export const prepareScheduleEnable = (
  input: Readonly<{ db: D1Database; userId: UserId; grantId: ConsentRecordId; now: DateTime.Utc }>
): Effect.Effect<ReadonlyArray<D1PreparedStatement>, InsightUnavailable> =>
  Effect.gen(function* () {
    const previous = yield* findSchedule(input);
    const timing: WeeklyTiming = Option.isSome(previous)
      ? previous.value.timing
      : { weekday: 0, hour: 18, minute: 0 };
    const timeZone = Option.isSome(previous)
      ? previous.value.timeZone
      : IanaTimeZone.make("America/Bogota");
    const id = Option.isSome(previous) ? previous.value.id : ScheduleId.make(newId());
    const version = Option.isSome(previous) ? previous.value.version + 1 : 1;
    const next = nextWeeklyOccurrence({ after: input.now, timing, timeZone });
    const schedule = WeeklyScheduleSnapshot.make({
      id,
      userId: input.userId,
      version: ScheduleVersion.make(version),
      enabled: true,
      timing,
      timeZone,
      serviceMarket: "CO",
      locale: "es-CO",
      nextScheduledAt: next,
      consentGrantId: input.grantId,
    });
    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(WeeklyScheduleSnapshot))
    )(schedule).pipe(Effect.mapError(() => new InsightUnavailable()));
    const params = [
      id,
      input.userId,
      version,
      1,
      timing.weekday,
      timing.hour,
      timing.minute,
      timeZone,
      "CO",
      "es-CO",
      DateTime.formatIso(next),
      input.grantId,
    ];
    const write = input.db
      .prepare(
        `INSERT INTO weekly_schedules (${scheduleColumns}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,enabled=1,next_scheduled_at=excluded.next_scheduled_at,consent_grant_id=excluded.consent_grant_id`
      )
      .bind(...params);
    const revision = input.db
      .prepare(
        "INSERT INTO weekly_schedule_revisions (user_id,schedule_id,version,snapshot_json) VALUES (?,?,?,?)"
      )
      .bind(input.userId, id, version, json);
    return [write, scheduleAssertion(input.db), revision];
  });

export const prepareScheduleDisable = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): D1PreparedStatement =>
  input.db.prepare("UPDATE weekly_schedules SET enabled = 0 WHERE user_id = ?").bind(input.userId);
