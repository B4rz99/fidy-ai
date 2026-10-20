import { DateTime, Effect, Option, Schema } from "effect";
import * as ScheduleStore from "./schedule-store";
import { UtcTimestamp } from "../../../src/core/_shared/time";
import { type ConsentRecordId } from "../../../src/core/consent/contract";
import { type UserId } from "../../../src/core/identity/contract";
import {
  ScheduleId,
  ScheduleVersion,
  type WeeklyTiming,
} from "../../../src/core/insights/contract";
import { nextWeeklyOccurrence } from "../../../src/core/insights/operations";
import { prepareConsentAction, prepareWeeklyConsentAction } from "../../consent/operations";
import { readUserContext } from "../../identity/user-context/operations";
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
  snapshot_json: Schema.fromJsonString(Schema.toCodecJson(WeeklyScheduleSnapshot)),
  next_scheduled_at: UtcTimestamp,
  consent_grant_id: WeeklyScheduleSnapshot.fields.consentGrantId,
});
const decodeSchedule = (raw: unknown): Effect.Effect<WeeklyScheduleSnapshot, InsightUnavailable> =>
  Effect.gen(function* () {
    const row = yield* Schema.decodeUnknownEffect(ScheduleRow)(raw);
    if (
      row.id !== row.snapshot_json.id ||
      row.user_id !== row.snapshot_json.userId ||
      row.version !== row.snapshot_json.version
    ) {
      return yield* new InsightUnavailable();
    }
    return WeeklyScheduleSnapshot.make({
      ...row.snapshot_json,
      enabled: row.enabled === 1,
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
          sql: "SELECT id,user_id,version,enabled,snapshot_json,next_scheduled_at,consent_grant_id FROM schedules WHERE kind='weekly' AND user_id=?",
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
          "SELECT user_id AS userId,id FROM schedules WHERE kind='weekly' AND enabled = 1 AND next_scheduled_at <= ? ORDER BY last_evaluated_at_ms,next_scheduled_at,id LIMIT 64"
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
        "UPDATE schedules SET last_evaluated_at_ms = ? WHERE kind='weekly' AND user_id = ? AND id = ? AND enabled = 1"
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
      sql: `${input.statement.sql} AND EXISTS (SELECT 1 FROM schedules WHERE kind='weekly' AND user_id = ? AND id = ? AND version = ? AND enabled = 1 AND next_scheduled_at = ? AND next_scheduled_at <= ? AND consent_grant_id = ?)`,
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
  return ScheduleStore.prepareAdvance({
    db,
    kind: "weekly",
    snapshot,
    scheduledAt: materializedScheduledAt,
    next,
    outcome: input.outcome,
    guard: (statement) => occurrenceGuard({ ...input, statement }),
  });
};

export const prepareScheduleEnable = (
  input: Readonly<{ db: D1Database; userId: UserId; grantId: ConsentRecordId; now: DateTime.Utc }>
): Effect.Effect<ReadonlyArray<D1PreparedStatement>, InsightUnavailable> =>
  Effect.gen(function* () {
    const previous = yield* findSchedule(input);
    const timing: WeeklyTiming = Option.isSome(previous)
      ? previous.value.timing
      : { weekday: 0, hour: 18, minute: 0 };
    const userContext = yield* readUserContext({
      db: input.db,
      userId: input.userId,
      authority: Option.none(),
    }).pipe(Effect.mapError(() => new InsightUnavailable()));
    if (Option.isNone(userContext)) return yield* new InsightUnavailable();
    const timeZone = Option.isSome(previous) ? previous.value.timeZone : userContext.value.timeZone;
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
    return ScheduleStore.prepareActivation({
      ...input,
      kind: "weekly",
      snapshot: schedule,
      json,
    });
  });

export const prepareScheduleDisable = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): D1PreparedStatement => ScheduleStore.prepareDisable({ ...input, kind: "weekly" });
