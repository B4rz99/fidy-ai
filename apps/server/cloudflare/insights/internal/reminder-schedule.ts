import { DateTime, Effect, Option, Schema } from "effect";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { MoneyGroups } from "../../../src/core/_shared/money";
import { UtcTimestamp } from "../../../src/core/_shared/time";
import { type ConsentRecordId } from "../../../src/core/consent/contract";
import { type UserId } from "../../../src/core/identity/contract";
import {
  InsightEventId,
  ReminderSchedule,
  type ReminderScheduleEdit,
  ReminderStanding,
  ScheduleId,
  ScheduleVersion,
} from "../../../src/core/insights/contract";
import {
  insightDeliveryDeadline,
  latestReminderOccurrence,
  nextReminderOccurrence,
} from "../../../src/core/insights/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { prepareConsentAction, prepareProactivityConsentAction } from "../../consent/operations";
import { newId } from "../../secret-material/operations";
import {
  InsightUnavailable,
  type ReminderMaterialization,
  ReminderRevisionConflict,
  ReminderScheduleSnapshot,
} from "../contract";

type Scope = Readonly<{ db: D1Database; userId: UserId }>;
const ScheduleRow = Schema.Struct({
  id: ScheduleId,
  version: ScheduleVersion,
  enabled: Schema.Literals([0, 1]),
  snapshot_json: Schema.fromJsonString(Schema.toCodecJson(ReminderSchedule)),
  next_scheduled_at: UtcTimestamp,
  consent_grant_id: ReminderScheduleSnapshot.fields.consentGrantId,
});
const assertion = (db: D1Database): D1PreparedStatement =>
  db.prepare(
    "INSERT INTO reminder_schedule_assertion(id,accepted) VALUES (1,CASE WHEN changes()=1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted=excluded.accepted"
  );

export const findSchedule = (
  input: Scope
): Effect.Effect<Option.Option<ReminderScheduleSnapshot>, InsightUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: "SELECT id,version,enabled,snapshot_json,next_scheduled_at,consent_grant_id FROM reminder_schedules WHERE user_id=?",
          params: [input.userId],
        },
      }).first()
    );
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(ScheduleRow)(raw);
    if (row.id !== row.snapshot_json.id || row.version !== row.snapshot_json.version) {
      return yield* new InsightUnavailable();
    }
    return Option.some(
      ReminderScheduleSnapshot.make({
        ...row.snapshot_json,
        enabled: row.enabled === 1,
        nextScheduledAt: row.next_scheduled_at,
        userId: input.userId,
        consentGrantId: row.consent_grant_id,
      })
    );
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const findStanding = (input: Scope): Effect.Effect<ReminderStanding, InsightUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: "SELECT standing_json FROM reminder_governors WHERE user_id=?",
          params: [input.userId],
        },
      }).first()
    );
    if (raw === null) return { _tag: "Attentive", unanswered: 0 } as const;
    return (yield* Schema.decodeUnknownEffect(
      Schema.Struct({ standing_json: Schema.fromJsonString(Schema.toCodecJson(ReminderStanding)) })
    )(raw)).standing_json;
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

const resetStanding = (input: Scope & Readonly<{ now: DateTime.Utc }>): D1PreparedStatement =>
  input.db
    .prepare(
      "INSERT INTO reminder_governors(user_id,standing_json,last_reply_at_ms) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET standing_json=excluded.standing_json,last_reply_at_ms=excluded.last_reply_at_ms"
    )
    .bind(
      input.userId,
      Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(ReminderStanding)))({
        _tag: "Attentive",
        unanswered: 0,
      }),
      input.now.epochMilliseconds
    );

const activationInstructions = (
  previous: Option.Option<ReminderScheduleSnapshot>,
  now: DateTime.Utc
): ReminderSchedule => {
  const instructions = Option.match(previous, {
    onNone: () => ({
      id: ScheduleId.make(newId()),
      version: ScheduleVersion.make(1),
      cadence: { kind: "daily" as const },
      timing: { hour: 18, minute: 0 },
      timeZone: IanaTimeZone.make("America/Bogota"),
      serviceMarket: "CO" as const,
      locale: "es-CO" as const,
    }),
    onSome: (schedule) => ({
      id: schedule.id,
      version: ScheduleVersion.make(schedule.version + 1),
      cadence: schedule.cadence,
      timing: schedule.timing,
      timeZone: schedule.timeZone,
      serviceMarket: schedule.serviceMarket,
      locale: schedule.locale,
    }),
  });
  return ReminderSchedule.make({
    ...instructions,
    enabled: true,
    nextScheduledAt: nextReminderOccurrence({ ...instructions, after: now }),
  });
};

export const prepareActivation = (
  input: Scope & Readonly<{ grantId: ConsentRecordId; now: DateTime.Utc }>
): Effect.Effect<ReadonlyArray<D1PreparedStatement>, InsightUnavailable> =>
  Effect.gen(function* () {
    const previous = yield* findSchedule(input);
    if (
      Option.isSome(previous) &&
      previous.value.enabled &&
      previous.value.consentGrantId === input.grantId
    ) {
      return [resetStanding(input)];
    }
    const schedule = activationInstructions(previous, input.now);
    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(ReminderSchedule))
    )(schedule);
    return [
      input.db
        .prepare(
          "INSERT INTO reminder_schedules(id,user_id,version,enabled,snapshot_json,next_scheduled_at,consent_grant_id) VALUES (?,?,?,1,?,?,?) ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,enabled=1,snapshot_json=excluded.snapshot_json,next_scheduled_at=excluded.next_scheduled_at,consent_grant_id=excluded.consent_grant_id"
        )
        .bind(
          schedule.id,
          input.userId,
          schedule.version,
          json,
          DateTime.formatIso(schedule.nextScheduledAt),
          input.grantId
        ),
      assertion(input.db),
      input.db
        .prepare(
          "INSERT INTO reminder_schedule_revisions(user_id,schedule_id,version,snapshot_json) VALUES (?,?,?,?)"
        )
        .bind(input.userId, schedule.id, schedule.version, json),
      resetStanding(input),
    ];
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const prepareRevision = (
  input: Scope & Readonly<{ input: ReminderScheduleEdit; now: DateTime.Utc }>
): Effect.Effect<
  ReadonlyArray<D1PreparedStatement>,
  InsightUnavailable | ReminderRevisionConflict
> =>
  Effect.gen(function* () {
    const previous = yield* findSchedule(input);
    if (Option.isNone(previous)) return yield* new InsightUnavailable();
    const old = previous.value;
    if (old.version !== input.input.expectedVersion) return yield* new ReminderRevisionConflict();
    const schedule = ReminderSchedule.make({
      id: old.id,
      enabled: old.enabled,
      serviceMarket: old.serviceMarket,
      locale: old.locale,
      cadence: input.input.cadence,
      timing: input.input.timing,
      timeZone: input.input.timeZone,
      version: ScheduleVersion.make(old.version + 1),
      nextScheduledAt: nextReminderOccurrence({ ...input.input, after: input.now }),
    });
    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(ReminderSchedule))
    )(schedule).pipe(Effect.mapError(() => new InsightUnavailable()));
    const update = prepareProactivityConsentAction({
      db: input.db,
      userId: input.userId,
      kind: "manual-entry-reminder",
      grantId: old.consentGrantId,
      statement: {
        sql: "UPDATE reminder_schedules SET version=?,snapshot_json=?,next_scheduled_at=? WHERE user_id=? AND id=? AND version=? AND consent_grant_id=?",
        params: [
          schedule.version,
          json,
          DateTime.formatIso(schedule.nextScheduledAt),
          input.userId,
          old.id,
          old.version,
          old.consentGrantId,
        ],
      },
    });
    return [
      update,
      assertion(input.db),
      input.db
        .prepare(
          "INSERT INTO reminder_schedule_revisions(user_id,schedule_id,version,snapshot_json) VALUES (?,?,?,?)"
        )
        .bind(input.userId, schedule.id, schedule.version, json),
      assertion(input.db),
    ];
  });

export const prepareDisable = (input: Scope): D1PreparedStatement =>
  input.db.prepare("UPDATE reminder_schedules SET enabled=0 WHERE user_id=?").bind(input.userId);

type GenerationScope = Scope & Readonly<{ snapshot: ReminderScheduleSnapshot; now: DateTime.Utc }>;
const guard = (input: GenerationScope, statement: OwnedStatement): D1PreparedStatement =>
  prepareProactivityConsentAction({
    db: input.db,
    userId: input.userId,
    kind: "manual-entry-reminder",
    grantId: input.snapshot.consentGrantId,
    statement: {
      sql: `${statement.sql} AND EXISTS (SELECT 1 FROM reminder_schedules AS s JOIN reminder_governors AS g ON g.user_id=s.user_id WHERE s.user_id=? AND s.id=? AND s.version=? AND s.enabled=1 AND s.next_scheduled_at=? AND s.next_scheduled_at<=? AND s.consent_grant_id=? AND json_extract(g.standing_json,'$._tag') IN ('Attentive','QuestionDelivered'))`,
      params: [
        ...statement.params,
        input.userId,
        input.snapshot.id,
        input.snapshot.version,
        DateTime.formatIso(input.snapshot.nextScheduledAt),
        DateTime.formatIso(input.now),
        input.snapshot.consentGrantId,
      ],
    },
  });
const advance = (
  input: GenerationScope,
  scheduledAt: DateTime.Utc,
  expired: boolean
): ReadonlyArray<D1PreparedStatement> => {
  const snapshot = input.snapshot;
  const next = nextReminderOccurrence({ ...snapshot, after: input.now });
  return [
    guard(input, {
      sql: "INSERT INTO reminder_schedule_executions(user_id,schedule_id,schedule_version,scheduled_at,outcome) SELECT ?,?,?,?,? WHERE 1=1",
      params: [
        input.userId,
        snapshot.id,
        snapshot.version,
        DateTime.formatIso(scheduledAt),
        expired ? "expired" : "generated",
      ],
    }),
    assertion(input.db),
    guard(input, {
      sql: "UPDATE reminder_schedules SET next_scheduled_at=? WHERE user_id=? AND id=?",
      params: [DateTime.formatIso(next), input.userId, snapshot.id],
    }),
    assertion(input.db),
  ];
};

const occurrence = (
  input: GenerationScope &
    Readonly<{ scheduledAt: DateTime.Utc; expiresAt: DateTime.Utc; id: InsightEventId }>
): ReadonlyArray<D1PreparedStatement> => [
  guard(input, {
    sql: "INSERT INTO insight_events(id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json) SELECT ?,?,'manual-entry-reminder',?,?,?,?,?,?,? WHERE 1=1",
    params: [
      input.id,
      input.userId,
      input.snapshot.id,
      input.snapshot.version,
      input.snapshot.serviceMarket,
      input.snapshot.locale,
      input.snapshot.timeZone,
      DateTime.formatIso(input.scheduledAt),
      Schema.encodeSync(Schema.fromJsonString(Schema.toCodecJson(MoneyGroups)))([]),
    ],
  }),
  assertion(input.db),
  input.db
    .prepare(
      "INSERT INTO reminder_occurrence_reports(user_id,insight_event_id,consent_grant_id,expires_at_ms) VALUES (?,?,?,?)"
    )
    .bind(input.userId, input.id, input.snapshot.consentGrantId, input.expiresAt.epochMilliseconds),
  input.db
    .prepare("INSERT INTO reminder_outbox(user_id,insight_event_id,created_at_ms) VALUES (?,?,?)")
    .bind(input.userId, input.id, input.now.epochMilliseconds),
];

const eligibleSchedule = (
  input: Scope & Readonly<{ id: ScheduleId; now: DateTime.Utc }>
): Effect.Effect<Option.Option<ReminderScheduleSnapshot>, InsightUnavailable> =>
  Effect.gen(function* () {
    const found = yield* findSchedule(input);
    if (
      Option.isNone(found) ||
      found.value.id !== input.id ||
      !found.value.enabled ||
      found.value.nextScheduledAt.epochMilliseconds > input.now.epochMilliseconds
    ) {
      return Option.none();
    }
    const standing = yield* findStanding(input);
    return standing._tag === "Paused" || standing._tag === "QuestionPending"
      ? Option.none()
      : found;
  });

export const materialize = (
  input: Scope & Readonly<{ id: ScheduleId; now: DateTime.Utc }>
): Effect.Effect<ReminderMaterialization, InsightUnavailable> =>
  Effect.gen(function* () {
    const found = yield* eligibleSchedule(input);
    if (Option.isNone(found)) return { _tag: "NoWork" } as const;
    const snapshot = found.value;
    const scheduledAt = latestReminderOccurrence({ ...snapshot, atOrBefore: input.now });
    if (scheduledAt.epochMilliseconds < snapshot.nextScheduledAt.epochMilliseconds) {
      return { _tag: "NoWork" } as const;
    }
    const expiresAt = insightDeliveryDeadline({
      scheduledAt,
      nextScheduledAt: nextReminderOccurrence({ ...snapshot, after: scheduledAt }),
    });
    const expired = expiresAt.epochMilliseconds <= input.now.epochMilliseconds;
    const scope = { ...input, snapshot };
    const id = InsightEventId.make(newId());
    const statements = [
      ...(expired ? [] : occurrence({ ...scope, scheduledAt, expiresAt, id })),
      ...advance(scope, scheduledAt, expired),
    ];
    yield* Effect.tryPromise(() => input.db.batch(statements));
    return expired ? ({ _tag: "Expired" } as const) : ({ _tag: "Created", id } as const);
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
