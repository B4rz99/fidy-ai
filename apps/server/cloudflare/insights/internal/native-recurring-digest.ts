import { InsightUnavailable } from "../contract";
import type { StoreCapacityUnavailable } from "../../runtime/sqlite/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { DateTime, Effect, Option, Schema } from "effect";
import * as Arr from "effect/Array";
import { ConsentSubject } from "./consent-subject";
import {
  type ConfirmationDay,
  InsightEvent,
  InsightEventId,
  RecurringDigestPayload,
  RecurringDigestReport,
  ScheduleId,
  ScheduleVersion,
} from "../../../src/core/insights/contract";
import {
  captureConfirmationDay,
  recurringDigestTiming,
} from "../../../src/core/insights/operations";
import { UserContext, type UserId } from "../../../src/core/identity/contract";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { RecurringSeriesConfirmed } from "../../../src/core/recurring/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { preserveStoreAlarm, withStoreAdmission } from "../../runtime/sqlite/operations";
import { newId } from "../../secret-material/operations";
import { presentation, sortedDigestItems } from "./recurring-presentation";
import { maximumItems } from "./recurring-models";

export const activateDigest = Effect.fn(function* (user: UserId, grant: string, now: number) {
  const sql = yield* SqliteClient;
  const [row] = yield* sql`SELECT time_zone FROM users WHERE id=${user}`;
  const zone = yield* Schema.decodeUnknownEffect(IanaTimeZone)(row?.time_zone);
  const day = captureConfirmationDay({ confirmedAt: DateTime.makeUnsafe(now), timeZone: zone });
  yield* sql`INSERT INTO recurring_digest_instructions VALUES(${user},${newId()},1,${grant},${day.from.epochMilliseconds},${now}) ON CONFLICT(user_id) DO UPDATE SET grant_id=excluded.grant_id,revision=revision+1,acceptance_from_ms=excluded.acceptance_from_ms,next_ms=excluded.next_ms`;

  return now;
});

const sourceRow = Schema.Struct({
  series_id: Schema.String,
  confirmation_id: Schema.String,
  confirmed_at_ms: Schema.Int,
  valid: Schema.Literals([0, 1]),
  digest_excluded: Schema.NullOr(Schema.Literals([0, 1])),
  context: Schema.fromJsonString(Schema.toCodecJson(UserContext)),
  confirmation_json: Schema.NullOr(Schema.String),
});

const instruction = Schema.Struct({
  user_id: Schema.String,
  id: ScheduleId,
  revision: ScheduleVersion,
  grant_id: Schema.String,
  acceptance_from_ms: Schema.Int,
  cutoff: Schema.Int,
});

type Instruction = typeof instruction.Type;

type Source = typeof sourceRow.Type;

const dayOf = (row: Source): ConfirmationDay =>
  captureConfirmationDay({
    confirmedAt: DateTime.makeUnsafe(row.confirmed_at_ms),
    timeZone: row.context.timeZone,
  });

const eligible = Effect.fn(function* (row: Source) {
  if (row.valid !== 1 || row.digest_excluded !== 0 || row.confirmation_json === null) {
    return Option.none();
  }

  const original = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(RecurringSeriesConfirmed))
  )(row.confirmation_json);

  if (
    original.seriesId !== row.series_id ||
    original.id !== row.confirmation_id ||
    original.confirmedAt.epochMilliseconds !== row.confirmed_at_ms
  ) {
    return yield* new InsightUnavailable({ cause: Option.none() });
  }

  return original.announcement.kind === "eligible"
    ? Option.some({
        confirmationId: original.id,
        seriesId: original.seriesId,
        confirmedAt: original.confirmedAt,
        counterparty: original.counterparty,
        cadence: original.cadence,
        money: original.money,
      })
    : Option.none();
});

const sourceDecision = (included: boolean, row: Source): string => {
  if (included) return "included";

  if (row.valid === 0) return "invalid";

  return row.digest_excluded === 0 ? "suppressed" : "excluded";
};

const freezeDay = Effect.fn(function* (
  held: Instruction,
  day: ConfirmationDay,
  sources: ReadonlyArray<Source>
) {
  const sql = yield* SqliteClient;

  const [closed] =
    yield* sql`SELECT event_id FROM recurring_digest_days WHERE from_ms=${day.from.epochMilliseconds} AND to_ms=${day.toExclusive.epochMilliseconds}`;

  const matches = yield* Effect.forEach(
    sources,
    Effect.fnUntraced(function* (row) {
      const match = yield* eligible(row);
      const included = Option.isSome(match) && closed === undefined;
      const disposition = sourceDecision(included, row);
      yield* sql`INSERT INTO recurring_digest_claims VALUES(${row.confirmation_id},${day.from.epochMilliseconds},${day.toExclusive.epochMilliseconds},${disposition})`;

      return included ? match : Option.none();
    })
  );

  const items = Arr.getSomes(matches);

  if (closed !== undefined) return;
  const first = sources[0];

  if (first === undefined) return yield* new InsightUnavailable({ cause: Option.none() });
  const id = items.length === 0 ? null : InsightEventId.make(newId());

  if (id !== null) {
    const payload = yield* Schema.decodeUnknownEffect(Schema.toType(RecurringDigestPayload))({
      confirmationDay: day,
      items: sortedDigestItems(items),
    });

    const report = RecurringDigestReport.make({
      insightEventId: id,
      serviceMarket: first.context.serviceMarket,
      locale: first.context.locale,
      payload,
      ...recurringDigestTiming(day),
    });

    const event = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.toCodecJson(InsightEvent))
    )({
      id,
      kind: "new-recurring-series",
      scheduleId: held.id,
      scheduleVersion: held.revision,
      ...first.context,
      scheduledAt: report.scheduledAt,
      lifecycleState: "pending",
      moneyGroups: [],
    });

    yield* sql`INSERT INTO insight_events(user_id,id,schedule_id,revision,scheduled_ms,event_json) VALUES(${held.user_id},${id},${held.id},${held.revision},${report.scheduledAt.epochMilliseconds},${event})`;
    yield* sql`INSERT INTO recurring_digest_reports VALUES(${id},${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(RecurringDigestReport)))(report)})`;
    yield* sql`INSERT INTO category_alert_groups VALUES(${id},${held.grant_id},${presentation(report)},${report.expiresAt.epochMilliseconds},${report.scheduledAt.epochMilliseconds})`;
  }

  yield* sql`INSERT INTO recurring_digest_days VALUES(${day.from.epochMilliseconds},${day.toExclusive.epochMilliseconds},${id})`;
});

const sourceAdmission = protectConsentStatement({
  subject: ConsentSubject.Owner({ column: "u.id" }),
  requirement: "active",
  statement: {
    sql: "SELECT i.*,p.evaluated_at_ms AS cutoff FROM recurring_digest_instructions i JOIN users u ON u.id=i.user_id JOIN proactive_grants g ON g.user_id=u.id AND g.id=i.grant_id AND g.kind='new-recurring-series' AND g.revoked_at_ms IS NULL JOIN recurring_evaluation_records p ON p.kind='progress' AND p.user_id=u.id AND p.phase='complete' JOIN transaction_projection_state s ON s.user_id=u.id AND s.fact_revision=p.evaluated_revision WHERE i.next_ms<=? AND NOT EXISTS(SELECT 1 FROM erasure_requests)",
    params: [],
  },
});

const consumeDigest = Effect.fn(function* (
  now: number,
  storage: DurableObjectStorage,
  admit: Effect.Effect<void, StoreCapacityUnavailable>
) {
  const sql = yield* SqliteClient;
  const [record] = yield* sql.unsafe(sourceAdmission.sql, [now, ...sourceAdmission.params]);

  if (record === undefined) {
    yield* sql`UPDATE recurring_digest_instructions SET next_ms=NULL WHERE next_ms<=${now}`;

    return;
  }

  const held = yield* Schema.decodeUnknownEffect(instruction)(record);

  const candidates = yield* Schema.decodeUnknownEffect(
    Schema.Array(sourceRow).check(Schema.isMaxLength(maximumItems))
  )(
    yield* sql`SELECT r.id AS series_id,r.confirmation_id,r.confirmed_at_ms,r.confirmation_context_json AS context,r.confirmation_json,r.digest_excluded,r.valid FROM recurring_series r WHERE r.user_id=${held.user_id} AND r.confirmed_at_ms>=${held.acceptance_from_ms} AND NOT EXISTS(SELECT 1 FROM recurring_digest_claims c WHERE c.confirmation_id=r.confirmation_id) ORDER BY r.confirmed_at_ms,r.confirmation_id LIMIT ${maximumItems + 1}`
  );

  const selected = candidates.find(
    (row) => dayOf(row).toExclusive.epochMilliseconds <= Math.min(held.cutoff, now)
  );

  let next = Option.none<number>();

  if (selected !== undefined) {
    yield* admit;
    const day = dayOf(selected);
    yield* freezeDay(
      held,
      day,
      candidates.filter((row) => {
        const other = dayOf(row);

        return (
          other.from.epochMilliseconds === day.from.epochMilliseconds &&
          other.toExclusive.epochMilliseconds === day.toExclusive.epochMilliseconds
        );
      })
    );
    next = Option.some(now + 1);
  } else if (candidates.length > 0) {
    const close = Math.min(...candidates.map((row) => dayOf(row).toExclusive.epochMilliseconds));

    if (close > now) next = Option.some(close);
  }

  yield* sql`UPDATE recurring_digest_instructions SET next_ms=${Option.getOrNull(next)} WHERE user_id=${held.user_id} AND grant_id=${held.grant_id}`;

  if (Option.isSome(next)) yield* preserveStoreAlarm(storage, next.value);
});

export const produceDigest = Effect.fn(function* (now: number, storage: DurableObjectStorage) {
  return yield* withStoreAdmission((admit) => consumeDigest(now, storage, admit));
});
