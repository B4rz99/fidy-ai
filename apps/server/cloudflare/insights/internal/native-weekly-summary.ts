import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { DateTime, Effect, Option, Predicate, Schema } from "effect";
import { ConsentSubject } from "./consent-subject";
import { Hex } from "effect/encoding";
import { UserId } from "../../../src/core/identity/contract";
import { InsightEvent, InsightEventId, WeeklySchedule } from "../../../src/core/insights/contract";
import { listLaunchCategories } from "../../../src/core/categories/operations";
import { groupMoney } from "../../../src/core/_shared/money";
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
import {
  type InsightTemplateSender,
  InsightTemplateSummary,
} from "../../../src/shell/channels/whatsapp/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { withStoreAdmission } from "../../runtime/sqlite/operations";
import { digestBytes, newId } from "../../secret-material/operations";
import {
  readLocalFactSnapshot,
  readLocalTransactionAggregate,
} from "../../transactions/operations";
import { InsightUnavailable } from "../contract";

const scheduleCodec = Schema.fromJsonString(Schema.toCodecJson(WeeklySchedule));

const row = Schema.Struct({
  user_id: UserId,
  grant_id: Schema.String,
  next_ms: Schema.Int,
  snapshot_json: scheduleCodec,
  portfolio: Schema.String,
  bsuid: Schema.String,
  endpoint: Schema.String,
});

const frozenPayload = Effect.fn(function* (
  user: UserId,
  at: DateTime.Utc,
  schedule: WeeklySchedule
) {
  const snapshot = yield* readLocalFactSnapshot(user);

  if (Option.isNone(snapshot)) return Option.none<WeeklySummaryPayload>();
  const periods = weeklyPeriods({ scheduledAt: at, timeZone: schedule.timeZone });

  const aggregate = Effect.fn(function* (period: typeof periods.current) {
    return {
      period,
      aggregates: yield* readLocalTransactionAggregate(
        user,
        period.from.epochMilliseconds,
        period.toExclusive.epochMilliseconds
      ),
    };
  });

  const summary = buildWeeklySummary({
    periods,
    facts: {
      revision: snapshot.value.revision,
      periods: [yield* aggregate(periods.current), yield* aggregate(periods.previous)],
    },
  });

  return Predicate.isTagged(summary, "Summary")
    ? Option.some(summary.payload)
    : Option.none<WeeklySummaryPayload>();
});

const renderReport = Effect.fn(function* (
  { id, at, schedule }: { id: InsightEventId; at: DateTime.Utc; schedule: WeeklySchedule },
  payload: WeeklySummaryPayload,
  sender: InsightTemplateSender
) {
  const observed = yield* Effect.fromOption(
    presentWeeklySummary({
      payload,
      categories: listLaunchCategories(),
      timeZone: schedule.timeZone,
    }),
    () => new InsightUnavailable({ cause: Option.none() })
  );

  const presentation = yield* Schema.decodeUnknownEffect(InsightTemplateSummary)(observed);
  const prepared = yield* sender.prepare(presentation);

  const body = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        summary: InsightTemplateSummary,
        text: Schema.String,
        parameter: Schema.String,
      })
    )
  )({ summary: presentation, ...prepared });

  const digest = Hex.encode(
    yield* digestBytes(
      new TextEncoder().encode(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(body)
      )
    )
  );

  const moneyGroups = yield* groupMoney({
    inflows: payload.groups.map((group) => group.inflow.current),
    outflows: payload.groups.map((group) => group.outflow.current),
  });

  const event = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(InsightEvent)))(
    {
      id,
      kind: "weekly-summary",
      scheduleId: schedule.id,
      scheduleVersion: schedule.version,
      serviceMarket: schedule.serviceMarket,
      locale: schedule.locale,
      timeZone: schedule.timeZone,
      scheduledAt: at,
      lifecycleState: "pending",
      moneyGroups,
    }
  );

  return { event, body, digest, presentation };
});

export const materializeWeekly = Effect.fn(function* (now: number, sender: InsightTemplateSender) {
  return yield* withStoreAdmission((admitGrowth) =>
    Effect.gen(function* () {
      const sql = yield* SqliteClient;

      const live = protectConsentStatement({
        subject: ConsentSubject.Owner({ column: "u.id" }),
        requirement: "active",
        statement: {
          sql: "SELECT s.*,c.portfolio,c.bsuid,c.endpoint FROM weekly_schedules s JOIN proactive_grants g ON g.id=s.grant_id AND g.user_id=s.user_id AND g.revoked_at_ms IS NULL JOIN reminder_channels c ON c.grant_id=g.id JOIN users u ON u.id=s.user_id AND u.whatsapp_portfolio_id=c.portfolio AND u.whatsapp_bsuid=c.bsuid WHERE s.next_ms<=? AND NOT EXISTS(SELECT 1 FROM erasure_requests) AND NOT EXISTS(SELECT 1 FROM weekly_attention a WHERE a.grant_id=g.id AND (a.paused_ms IS NOT NULL OR (a.ask_ms IS NOT NULL AND a.question_delivered_ms IS NULL))) AND json_extract(s.snapshot_json,'$.enabled')=1",
          params: [now],
        },
      });

      const [raw] = yield* sql.unsafe(live.sql, live.params);

      if (raw === undefined) return;
      const held = yield* Schema.decodeUnknownEffect(row)(raw);

      const user = held.user_id,
        schedule = held.snapshot_json;

      const at = latestWeeklyOccurrence({ atOrBefore: DateTime.makeUnsafe(now), ...schedule });

      const next = nextWeeklyOccurrence({ after: at, ...schedule }),
        expires = insightDeliveryDeadline({ scheduledAt: at, nextScheduledAt: next });

      const encoded = yield* Schema.encodeEffect(scheduleCodec)({
        ...schedule,
        nextScheduledAt: next,
      });

      const advanced =
        yield* sql`UPDATE weekly_schedules SET next_ms=${next.epochMilliseconds},snapshot_json=${encoded} WHERE id=${schedule.id} AND next_ms=${held.next_ms} RETURNING id`;

      if (advanced.length !== 1) return;

      if (expires.epochMilliseconds <= now) return;
      const payload = yield* frozenPayload(user, at, schedule);

      if (Option.isNone(payload)) return;
      const id = InsightEventId.make(newId());

      const { event, body, digest, presentation } = yield* renderReport(
        { id, at, schedule },
        payload.value,
        sender
      );

      yield* admitGrowth;
      yield* sql`INSERT INTO insight_events(user_id,id,schedule_id,revision,scheduled_ms,event_json) VALUES(${user},${id},${schedule.id},${schedule.version},${at.epochMilliseconds},${event})`;
      yield* sql`INSERT INTO weekly_summary_reports VALUES(${id},${held.grant_id},${yield* Schema.encodeEffect(Schema.fromJsonString(InsightTemplateSummary))(presentation)},${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(WeeklySummaryPayload)))(payload.value)},${expires.epochMilliseconds})`;
      yield* sql`INSERT INTO reminder_deliveries(id,user_id,grant_id,correlation,portfolio,bsuid,endpoint,deadline_ms,offer_ms,body,digest,created_ms,observation_kind) VALUES(${id},${user},${held.grant_id},${newId()},${held.portfolio},${held.bsuid},${held.endpoint},${expires.epochMilliseconds},${now},${body},${digest},${now},'weekly-summary')`;
    })
  );
});
