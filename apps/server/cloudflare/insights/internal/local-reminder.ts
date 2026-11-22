import { produceDigest } from "./native-recurring-digest";
import { publishCategoryMessages } from "./local-category-messages";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Data, DateTime, Effect, Option, Predicate, Result, Schema } from "effect";
import { ConsentSubject } from "./consent-subject";
import { Hex } from "effect/encoding";
import {
  InsightEvent,
  InsightEventId,
  ReminderSchedule,
} from "../../../src/core/insights/contract";
import {
  decideInsightDelivery,
  insightDeliveryDeadline,
  latestReminderOccurrence,
  nextReminderOccurrence,
} from "../../../src/core/insights/operations";
import {
  UserId,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../../src/core/identity/contract";
import {
  HostedDeliveryCorrelationToken,
  type InsightTemplateSender,
  InsightTemplateSummary,
  PreparedProactivityTemplate,
  type ProactivityTemplateSender,
} from "../../../src/shell/channels/whatsapp/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { digestBytes, newId } from "../../secret-material/operations";
import {
  chargeLocalProvider,
  reserveSharedProviderSpend,
} from "../../resource-admission/operations";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { claimRegisteredSend, recordRegisteredSend } from "../../whatsapp/operations";
import {
  CategoryDeliveryWork,
  InsightUnavailable,
  type NativeReminderEnvironment,
  type ProactivityActivityResult,
} from "../contract";
import { type ExternalEventBindings } from "../../directory/contract";
import { sendEvidence } from "./weekly-execution";

type Owners = ExternalEventBindings;

type QueueEnv = Pick<NativeReminderEnvironment, "WEEKLY_DELIVERY_QUEUE" | "PROACTIVITY_ENABLED">;

const secondOfferMs = 60000,
  offerPage = 16;

const Contact = Schema.Struct({
  portfolio: WhatsAppBusinessPortfolioId,
  bsuid: WhatsAppBusinessScopedUserId,
  endpoint: WhatsAppBusinessPhoneNumberId,
});

const snapshotRow = Schema.Struct({
  ...Contact.fields,
  user_id: UserId,
  grant_id: Schema.String,
  snapshot_json: Schema.fromJsonString(Schema.toCodecJson(ReminderSchedule)),
});

const dueRow = Effect.fn(function* (now: number) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT s.user_id,s.grant_id,s.snapshot_json,c.portfolio,c.bsuid,c.endpoint FROM reminder_schedules s
    JOIN users u ON u.id=s.user_id JOIN proactive_grants g ON g.user_id=u.id AND g.id=s.grant_id AND g.kind='manual-entry-reminder' AND g.revoked_at_ms IS NULL
    JOIN reminder_channels c ON c.grant_id=g.id AND c.portfolio=u.whatsapp_portfolio_id AND c.bsuid=u.whatsapp_bsuid
    WHERE NOT EXISTS(SELECT 1 FROM reminder_attention a WHERE a.grant_id=s.grant_id AND (a.unanswered=5 OR (a.unanswered=3 AND a.question_delivered_ms IS NULL))) AND s.next_at_ms<=${now} AND s.retry_at_ms<=${now} AND json_extract(s.snapshot_json,'$.enabled')=1 AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=u.id) LIMIT 1`;

  if (row === undefined) return Option.none();
  const candidate = yield* Schema.decodeUnknownEffect(snapshotRow)(row);

  const guard = protectConsentStatement({
    statement: { sql: "SELECT id FROM users WHERE id=?", params: [candidate.user_id] },
    subject: ConsentSubject.User({ userId: candidate.user_id }),
    requirement: "active",
  });

  return (yield* sql.unsafe(guard.sql, guard.params)).length === 1
    ? Option.some(candidate)
    : Option.none();
});

const materialize = Effect.fn(function* (
  now: number,
  sender: ProactivityTemplateSender,
  owns: (id: string) => boolean
) {
  const candidate = yield* dueRow(now);

  if (Option.isNone(candidate) || !owns(candidate.value.user_id)) return;

  const held = candidate.value,
    schedule = held.snapshot_json,
    current = DateTime.makeUnsafe(now);

  const at = latestReminderOccurrence({ ...schedule, atOrBefore: current }),
    next = nextReminderOccurrence({ ...schedule, after: current });

  if (at.epochMilliseconds < schedule.nextScheduledAt.epochMilliseconds) return;
  const sql = yield* SqliteClient;

  const until = insightDeliveryDeadline({
    scheduledAt: at,
    nextScheduledAt: nextReminderOccurrence({ ...schedule, after: at }),
  });

  const instructions = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(ReminderSchedule))
  )({ ...schedule, nextScheduledAt: next });

  yield* sql`UPDATE reminder_schedules SET next_at_ms=${next.epochMilliseconds},snapshot_json=${instructions} WHERE user_id=${held.user_id} AND revision=${schedule.version}`;

  if (until.epochMilliseconds <= now) return;

  const charged = yield* chargeLocalProvider(
    { phase: "reminderGeneration", units: 1 },
    "user",
    now
  );

  if (!charged) return;
  const id = InsightEventId.make(newId());

  const event = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(InsightEvent)))(
    {
      id,
      kind: "manual-entry-reminder",
      scheduleId: schedule.id,
      scheduleVersion: schedule.version,
      serviceMarket: schedule.serviceMarket,
      locale: schedule.locale,
      timeZone: schedule.timeZone,
      scheduledAt: at,
      moneyGroups: [],
      lifecycleState: "pending",
    }
  );

  const template = yield* sender.prepare("Recuerda registrar tus movimientos manuales en Fidy.");

  const body = yield* Schema.encodeEffect(Schema.fromJsonString(PreparedProactivityTemplate))(
    template
  );

  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(body);
  const digest = Hex.encode(yield* digestBytes(new TextEncoder().encode(encoded)));
  const correlation = HostedDeliveryCorrelationToken.make(newId());
  yield* sql`INSERT INTO insight_events(user_id,id,schedule_id,revision,scheduled_ms,event_json) VALUES(${held.user_id},${id},${schedule.id},${schedule.version},${at.epochMilliseconds},${event})`;
  yield* sql`INSERT INTO reminder_deliveries(id,user_id,grant_id,correlation,portfolio,bsuid,endpoint,deadline_ms,offer_ms,body,digest,created_ms) VALUES(${id},${held.user_id},${held.grant_id},${correlation},${held.portfolio},${held.bsuid},${held.endpoint},${until.epochMilliseconds},${now},${body},${digest},${now})`;
});

export const repairReminder = Effect.fn(function* (
  now: number,
  storage: DurableObjectStorage,
  enabled: boolean
) {
  if (!enabled) return false;
  const sql = yield* SqliteClient;

  const schedule = protectConsentStatement({
    subject: ConsentSubject.Owner({ column: "u.id" }),
    requirement: "active",
    statement: {
      sql: `SELECT max(s.next_at_ms,s.retry_at_ms) AS at FROM reminder_schedules s JOIN proactive_grants g ON g.id=s.grant_id AND g.user_id=s.user_id AND g.revoked_at_ms IS NULL
      JOIN reminder_channels c ON c.grant_id=g.id JOIN users u ON u.id=s.user_id AND u.whatsapp_portfolio_id=c.portfolio AND u.whatsapp_bsuid=c.bsuid WHERE json_extract(s.snapshot_json,'$.enabled')=1 AND NOT EXISTS(SELECT 1 FROM reminder_attention a WHERE a.grant_id=s.grant_id AND (a.unanswered=5 OR (a.unanswered=3 AND a.question_delivered_ms IS NULL)))`,
      params: [],
    },
  });

  const [time] = yield* sql.unsafe(
    `SELECT min(at) AS at FROM (SELECT min(at) AS at FROM (${schedule.sql} UNION ALL SELECT d.offer_ms FROM reminder_deliveries d JOIN proactive_grants g ON g.id=d.grant_id WHERE d.state='ready' AND g.kind<>'weekly-summary' UNION ALL SELECT attempt_ms FROM reminder_disclosures WHERE state='ready' AND kind<>'weekly-summary' UNION ALL SELECT due_ms FROM category_alert_groups UNION ALL SELECT i.next_ms FROM recurring_digest_instructions i JOIN proactive_grants g ON g.id=i.grant_id AND g.revoked_at_ms IS NULL WHERE i.next_ms IS NOT NULL) UNION ALL SELECT next_ms FROM category_opportunities WHERE next_ms IS NOT NULL)`,
    schedule.params
  );

  const row = yield* Schema.decodeUnknownEffect(Schema.Struct({ at: Schema.NullOr(Schema.Int) }))(
    time
  );

  return Predicate.isNumber(row.at)
    ? yield* preserveStoreAlarm(storage, Math.max(now, row.at))
    : false;
});

const postOffer = Effect.fn(function* (
  queue: NonNullable<QueueEnv["WEEKLY_DELIVERY_QUEUE"]>,
  row: { id: InsightEventId; user_id: UserId; weekly: number },
  now: number
) {
  const sql = yield* SqliteClient;

  const work =
    row.weekly === 1
      ? {
          kind: "weekly-summary" as const,
          version: 1 as const,
          userId: row.user_id,
          insightEventId: row.id,
        }
      : CategoryDeliveryWork.make({
          kind: "proactivity-delivery",
          version: 1,
          owner: "user",
          userId: row.user_id,
          id: row.id,
        });

  yield* sql`UPDATE reminder_deliveries SET offer_ms=min(deadline_ms,${now + secondOfferMs}) WHERE id=${row.id} AND state='ready'`;
  yield* Effect.tryPromise(() => queue.send(work));
});

export const offerDeliveries = Effect.fn(function* (env: QueueEnv, now: number, weekly: boolean) {
  const sql = yield* SqliteClient;
  yield* sql`UPDATE reminder_deliveries SET state='expired' WHERE state='ready' AND deadline_ms<=${now}`;

  const rows = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ id: InsightEventId, user_id: UserId, weekly: Schema.Int }))
  )(
    yield* sql`SELECT d.id,d.user_id,(g.kind='weekly-summary') AS weekly FROM reminder_deliveries d JOIN proactive_grants g ON g.id=d.grant_id WHERE d.state='ready' AND d.offer_ms<=${now} AND (g.kind='weekly-summary')=${Number(weekly)} ORDER BY d.offer_ms,d.id LIMIT ${offerPage}`
  );

  const queue = env.WEEKLY_DELIVERY_QUEUE;

  if (rows.length > 0 && queue === undefined) {
    return yield* new InsightUnavailable({ cause: Option.none() });
  }

  if (queue === undefined) return { attempted: 0, failed: 0 };

  const results = yield* Effect.forEach(
    rows,
    (row) => postOffer(queue, row, now).pipe(Effect.result),
    { concurrency: 1 }
  );

  return {
    attempted: rows.length,
    failed: results.filter(Result.isFailure).length,
  };
});

export const processReminder = Effect.fn(function* (input: {
  environment: Owners & QueueEnv;
  sender: ProactivityTemplateSender;
  owns: (id: string) => boolean;
  storage: DurableObjectStorage;
}) {
  const { environment, storage, owns } = input,
    now = yield* Clock.currentTimeMillis;

  const candidate = yield* dueRow(now);

  if (Option.isSome(candidate) && owns(candidate.value.user_id)) {
    const sql = yield* SqliteClient;
    const original = candidate.value;
    yield* sql`UPDATE reminder_schedules SET retry_at_ms=${now + secondOfferMs} WHERE user_id=${original.user_id} AND revision=${original.snapshot_json.version} AND next_at_ms<=${now}`;

    if (
      yield* reserveSharedProviderSpend(environment.DIRECTORY, {
        phase: "reminderGeneration",
        units: 1,
      })
    ) {
      yield* Effect.gen(function* () {
        const released =
          yield* sql`UPDATE reminder_schedules SET retry_at_ms=0 WHERE user_id=${original.user_id} AND id=${original.snapshot_json.id} AND revision=${original.snapshot_json.version} AND next_at_ms=${original.snapshot_json.nextScheduledAt.epochMilliseconds} AND grant_id=${original.grant_id} RETURNING id`;

        if (released.length === 1) {
          yield* materialize(yield* Clock.currentTimeMillis, input.sender, owns);
        }
      }).pipe(withStoreCapacity("growth"));
    }
  }

  yield* produceDigest(now, storage);
  yield* publishCategoryMessages(now, input.sender);
  const results = yield* offerDeliveries(environment, now, false);
  yield* repairReminder(now, storage, true);

  return results;
});

const deliveryRow = Schema.Struct({
  ...Contact.fields,
  user_id: UserId,
  id: InsightEventId,
  correlation: HostedDeliveryCorrelationToken,
  deadline_ms: Schema.Int,
  body: Schema.String,
  event_json: Schema.fromJsonString(Schema.toCodecJson(InsightEvent)),
});

const sendBinding = (held: typeof deliveryRow.Type): Parameters<typeof claimRegisteredSend>[1] => ({
  userId: held.user_id,
  operationId: held.id,
  family: "proactivity" as const,
  endpoint: held.endpoint,
  portfolio: held.portfolio,
  bsuid: held.bsuid,
  sandboxPhone: null,
  correlation: held.correlation,
  deadline: held.deadline_ms,
  content: held.body,
});

type NativeSender = { category: ProactivityTemplateSender } | { weekly: InsightTemplateSender };

const preparedSend = Effect.fn(function* (held: typeof deliveryRow.Type, sender: NativeSender) {
  const channel = {
    recipient: held.bsuid,
    businessPhoneNumberId: held.endpoint,
    correlationToken: held.correlation,
  };

  if ("weekly" in sender) {
    const { summary } = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Struct({ summary: InsightTemplateSummary }))
    )(held.body);

    return (): ReturnType<InsightTemplateSender["send"]> =>
      sender.weekly.send({ ...channel, summary });
  }

  const template = yield* Schema.decodeEffect(Schema.fromJsonString(PreparedProactivityTemplate))(
    held.body
  );

  return (): ReturnType<ProactivityTemplateSender["send"]> =>
    sender.category.send({ ...channel, template });
});

const ActivityResult = Data.taggedEnum<ProactivityActivityResult>();

export const deliverReminder = Effect.fn(function* (
  env: Owners,
  work: { userId: UserId; id: string },
  sender: { category: ProactivityTemplateSender } | { weekly: InsightTemplateSender }
) {
  const sql = yield* SqliteClient,
    now = yield* DateTime.now;

  const [raw] =
    yield* sql`SELECT d.*,e.event_json FROM reminder_deliveries d JOIN insight_events e ON e.user_id=d.user_id AND e.id=d.id JOIN proactive_grants g ON g.id=d.grant_id AND g.user_id=d.user_id AND g.revoked_at_ms IS NULL WHERE d.user_id=${work.userId} AND d.id=${work.id} AND d.state='ready' AND (g.kind='weekly-summary')=${Number("weekly" in sender)}`;

  if (raw === undefined) return ActivityResult.Done();
  const held = yield* Schema.decodeUnknownEffect(deliveryRow)(raw);

  const decision = decideInsightDelivery({
    scheduledAt: held.event_json.scheduledAt,
    expiresAt: DateTime.makeUnsafe(held.deadline_ms),
    timeZone: held.event_json.timeZone,
    now,
  });

  if (Predicate.isTagged(decision, "Deferred")) {
    return ActivityResult.Deferred({ nextEligibleAtMs: decision.nextEligibleAt.epochMilliseconds });
  }

  if (Predicate.isTagged(decision, "Expired")) return ActivityResult.Done();
  const send = yield* preparedSend(held, sender);
  const prepared = sendBinding(held);
  const claim = yield* claimRegisteredSend(env, prepared);

  if (!(yield* reserveSharedProviderSpend(env.DIRECTORY, { phase: "reminderSend", units: 4096 }))) {
    return yield* new InsightUnavailable({ cause: Option.none() });
  }

  yield* sql`UPDATE reminder_deliveries SET spend_ready=1 WHERE id=${held.id} AND user_id=${held.user_id} AND state='ready'`;
  yield* claim.claim;
  const outcome = sendEvidence(yield* Effect.exit(send()));
  yield* recordRegisteredSend(env, {
    userId: held.user_id,
    operationId: held.id,
    family: "proactivity",
    endpoint: held.endpoint,
    correlation: held.correlation,
    state: outcome.certainty,
    message: Option.getOrNull(outcome.providerMessageId),
  });

  return ActivityResult.Done();
});
