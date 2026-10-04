import { DateTime, Effect, Option, Schema } from "effect";
import { MoneyGroups, type ReadonlyMoney, groupMoney } from "../../../src/core/_shared/money";
import { type UserId } from "../../../src/core/identity/contract";
import { InsightEventId, type ScheduleId } from "../../../src/core/insights/contract";
import {
  insightDeliveryDeadline,
  latestWeeklyOccurrence,
  nextWeeklyOccurrence,
  weeklyPeriods,
} from "../../../src/core/insights/operations";
import { WeeklySummaryPayload } from "../../../src/core/insights/weekly-summary/contract";
import {
  buildWeeklySummary,
  presentWeeklySummary,
} from "../../../src/core/insights/weekly-summary/operations";
import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { InsightTemplateSummary } from "../../../src/shell/channels/whatsapp/contract";
import { listCategories } from "../../categories/operations";
import { prepareConsentAction } from "../../consent/operations";
import { newId } from "../../secret-material/operations";
import {
  preparePeriodAggregateGuard,
  readCompletePeriodAggregates,
} from "../../transactions/operations";
import {
  InsightUnavailable,
  type WeeklyMaterialization,
  type WeeklyScheduleSnapshot,
  WeeklySummaryReport,
} from "../contract";
import {
  findSchedule,
  noteScheduleEvaluation,
  occurrenceGuard,
  scheduleAdvance,
} from "./weekly-schedule";

type GenerationScope = Readonly<{
  db: D1Database;
  snapshot: WeeklyScheduleSnapshot;
  now: DateTime.Utc;
  scheduledAt: DateTime.Utc;
  expiresAt: DateTime.Utc;
}>;
type Candidate =
  | Readonly<{ _tag: "NoActivity"; revision: number }>
  | Readonly<{
      _tag: "Report";
      id: InsightEventId;
      revision: number;
      groupsJson: string;
      payloadJson: string;
      presentationJson: string;
    }>;
const prepareCandidate = (scope: GenerationScope): Effect.Effect<Candidate, InsightUnavailable> =>
  Effect.gen(function* () {
    const periods = weeklyPeriods({
      scheduledAt: scope.scheduledAt,
      timeZone: scope.snapshot.timeZone,
    });
    const facts = yield* readCompletePeriodAggregates({
      db: scope.db,
      userId: scope.snapshot.userId,
      periods: [periods.current, periods.previous],
    });
    if (Option.isNone(facts)) return yield* new InsightUnavailable();
    const summary = buildWeeklySummary({ periods, facts: facts.value });
    if (summary._tag === "NoActivity") {
      return { _tag: "NoActivity", revision: facts.value.revision } as const;
    }
    const categories = yield* listCategories({ db: scope.db });
    const presentation = presentWeeklySummary({
      payload: summary.payload,
      categories,
      timeZone: scope.snapshot.timeZone,
    });
    if (Option.isNone(presentation)) return yield* new InsightUnavailable();
    const groups = yield* groupMoney({
      inflows: summary.payload.groups.map(
        (group: Readonly<{ inflow: Readonly<{ current: ReadonlyMoney }> }>) => group.inflow.current
      ),
      outflows: summary.payload.groups.map(
        (group: Readonly<{ outflow: Readonly<{ current: ReadonlyMoney }> }>) =>
          group.outflow.current
      ),
    });
    const groupsJson = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(MoneyGroups))
    )(groups);
    const payloadJson = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(WeeklySummaryPayload))
    )(summary.payload);
    const templateFacts = yield* Schema.decodeUnknownEffect(InsightTemplateSummary)(
      presentation.value
    );
    const presentationJson = yield* Schema.encodeEffect(
      Schema.fromJsonString(InsightTemplateSummary)
    )(templateFacts);
    return {
      _tag: "Report",
      id: InsightEventId.make(newId()),
      revision: facts.value.revision,
      groupsJson,
      payloadJson,
      presentationJson,
    } as const;
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

const reportStatements = (
  scope: GenerationScope,
  candidate: Extract<Candidate, { _tag: "Report" }>
): ReadonlyArray<D1PreparedStatement> => {
  const { db, snapshot, scheduledAt, expiresAt, now } = scope;
  const event = occurrenceGuard({
    ...scope,
    statement: {
      sql: `INSERT INTO insight_events (id,user_id,kind,schedule_id,schedule_version,service_market,locale,time_zone,scheduled_at,money_groups_json) SELECT ?,?,'weekly-summary',?,?,?,?,?,?,? WHERE 1 = 1`,
      params: [
        candidate.id,
        snapshot.userId,
        snapshot.id,
        snapshot.version,
        snapshot.serviceMarket,
        snapshot.locale,
        snapshot.timeZone,
        DateTime.formatIso(scheduledAt),
        candidate.groupsJson,
      ],
    },
  });
  const assertion = db.prepare(
    "INSERT INTO weekly_schedule_assertion (id,accepted) VALUES (1,CASE WHEN changes() = 1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted"
  );
  const report = db
    .prepare(
      `INSERT INTO weekly_summary_reports (user_id,insight_event_id,consent_grant_id,payload_json,presentation_json,scheduled_at_ms,expires_at_ms) VALUES (?,?,?,?,?,?,?)`
    )
    .bind(
      snapshot.userId,
      candidate.id,
      snapshot.consentGrantId,
      candidate.payloadJson,
      candidate.presentationJson,
      scheduledAt.epochMilliseconds,
      expiresAt.epochMilliseconds
    );
  const outbox = db
    .prepare(
      "INSERT INTO weekly_summary_outbox (user_id,insight_event_id,created_at_ms) VALUES (?,?,?)"
    )
    .bind(snapshot.userId, candidate.id, now.epochMilliseconds);
  return [event, assertion, report, outbox];
};
const commit = (
  db: D1Database,
  statements: ReadonlyArray<D1PreparedStatement>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.tryPromise({
    try: () => db.batch([...statements]),
    catch: () => new InsightUnavailable(),
  }).pipe(Effect.asVoid);

/** Caller enters the existing User coordinator and security admission before financial evaluation. No provider action occurs here. */
export const materialize = (
  input: Readonly<{ db: D1Database; userId: UserId; id: ScheduleId; now: DateTime.Utc }>
): Effect.Effect<WeeklyMaterialization, InsightUnavailable> =>
  Effect.gen(function* () {
    yield* noteScheduleEvaluation(input);
    const found = yield* findSchedule(input);
    if (Option.isNone(found)) return { _tag: "NoWork" } as const;
    const snapshot = found.value;
    if (
      snapshot.id !== input.id ||
      !snapshot.enabled ||
      snapshot.nextScheduledAt.epochMilliseconds > input.now.epochMilliseconds
    ) {
      return { _tag: "NoWork" } as const;
    }
    const scheduledAt = latestWeeklyOccurrence({
      atOrBefore: input.now,
      timing: snapshot.timing,
      timeZone: snapshot.timeZone,
    });
    const nextScheduledAt = nextWeeklyOccurrence({
      after: scheduledAt,
      timing: snapshot.timing,
      timeZone: snapshot.timeZone,
    });
    const expiresAt = insightDeliveryDeadline({ scheduledAt, nextScheduledAt });
    const scope = { db: input.db, snapshot, now: input.now, scheduledAt, expiresAt };
    if (expiresAt.epochMilliseconds <= input.now.epochMilliseconds) {
      yield* commit(
        input.db,
        scheduleAdvance({ ...scope, materializedScheduledAt: scheduledAt, outcome: "expired" })
      );
      return { _tag: "Expired" } as const;
    }
    const candidate = yield* prepareCandidate(scope);
    const guard = preparePeriodAggregateGuard({
      db: input.db,
      userId: input.userId,
      revision: candidate.revision,
    });
    const advance = scheduleAdvance({
      ...scope,
      materializedScheduledAt: scheduledAt,
      outcome: candidate._tag === "NoActivity" ? "empty" : "generated",
    });
    if (candidate._tag === "NoActivity") {
      yield* commit(input.db, [guard, ...advance]);
      return { _tag: "NoActivity" } as const;
    }
    yield* commit(input.db, [guard, ...reportStatements(scope, candidate), ...advance]);
    return { _tag: "Created", id: candidate.id } as const;
  });

/** Current enabled schedule and the same captured grant; timing revisions affect future reports only. */
export const weeklyReportDeliveryQuery = (
  input: Readonly<{ userId: UserId; insightEventId: InsightEventId }>
): OwnedStatement => ({
  sql: `SELECT 1 FROM weekly_summary_reports AS r JOIN insight_events AS e ON e.id=r.insight_event_id AND e.user_id=r.user_id JOIN weekly_schedules AS s ON s.id=e.schedule_id AND s.user_id=e.user_id WHERE r.user_id=? AND r.insight_event_id=? AND s.enabled=1 AND s.consent_grant_id=r.consent_grant_id`,
  params: [input.userId, input.insightEventId],
});

const ReportRow = Schema.Struct({
  insight_event_id: InsightEventId,
  consent_grant_id: WeeklySummaryReport.fields.consentGrantId,
  payload_json: Schema.String,
  presentation_json: Schema.String,
  expires_at_ms: Schema.Int,
});
export const findReport = (
  input: Readonly<{ db: D1Database; userId: UserId; id: InsightEventId }>
): Effect.Effect<Option.Option<WeeklySummaryReport>, InsightUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: "SELECT insight_event_id,consent_grant_id,payload_json,presentation_json,expires_at_ms FROM weekly_summary_reports WHERE user_id = ? AND insight_event_id = ?",
          params: [input.userId, input.id],
        },
      }).first()
    );
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(ReportRow)(raw);
    const payload = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(WeeklySummaryPayload))
    )(row.payload_json);
    const presentation = yield* Schema.decodeEffect(Schema.fromJsonString(InsightTemplateSummary))(
      row.presentation_json
    );
    const expiresAt = DateTime.make(row.expires_at_ms);
    if (Option.isNone(expiresAt)) return yield* new InsightUnavailable();
    if (
      presentation.currencies.join(",") !==
      payload.groups.map((group: Readonly<{ currency: string }>) => group.currency).join(",")
    ) {
      return yield* new InsightUnavailable();
    }
    return Option.some({
      insightEventId: row.insight_event_id,
      payload,
      presentation,
      expiresAt: expiresAt.value,
      consentGrantId: row.consent_grant_id,
    });
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
