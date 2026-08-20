import * as Arr from "effect/Array";
import { DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { Money, encodeMoneyAmount, groupMoney } from "~/core/_shared/money";
import { UserId } from "~/core/identity/reference";
import {
  type DetectedRecurringSeries,
  RecurringCurrencyGroup,
  RecurringSeries,
  type RecurringSeriesReport,
  RecurringSuppressionReason,
} from "~/core/recurring/model";
import { type RecurringCandidate } from "~/core/recurring/rules";
import { Counterparty, Direction, TransactionId } from "~/core/transactions/reference";
import { withUserTransaction } from "~/shell/db/user-transaction";

const SeriesFlatRow = Schema.Struct({
  id: Schema.toEncoded(RecurringSeries.fields.id),
  counterparty: Counterparty,
  direction: Direction,
  cadence: RecurringSeries.fields.cadence,
  typicalAmount: Money.fields.amount,
  typicalCurrency: Money.fields.currency,
  occurrences: Schema.Array(Schema.toEncoded(TransactionId)),
  firstOccurredAt: Schema.DateTimeUtcFromDate,
  lastOccurredAt: Schema.DateTimeUtcFromDate,
  suppressionReason: Schema.OptionFromNullOr(RecurringSuppressionReason),
  detectedAt: Schema.DateTimeUtcFromDate,
});

const seriesColumns = `id, counterparty, direction, cadence,
  typical_amount AS "typicalAmount", typical_currency AS "typicalCurrency", occurrences,
  first_occurred_at AS "firstOccurredAt", last_occurred_at AS "lastOccurredAt",
  suppression_reason AS "suppressionReason", detected_at AS "detectedAt"`;

const decodeSeries = Schema.decodeUnknownEffect(RecurringSeries);

// The row is flat and the model is a union: a NULL suppression reason is the announceable case,
// and that reconciliation belongs here rather than in either of the shapes it joins.
const seriesFromRow = Effect.fn("recurringSeriesFromRow")((row: typeof SeriesFlatRow.Type) =>
  decodeSeries({
    id: row.id,
    counterparty: row.counterparty,
    direction: row.direction,
    cadence: row.cadence,
    typicalMoney: {
      amount: encodeMoneyAmount(row.typicalAmount),
      currency: row.typicalCurrency,
    },
    occurrences: row.occurrences,
    firstOccurredAt: DateTime.formatIso(row.firstOccurredAt),
    lastOccurredAt: DateTime.formatIso(row.lastOccurredAt),
    announcement: Option.match(row.suppressionReason, {
      onNone: () => ({ state: "announceable" }),
      onSome: (reason) => ({ state: "suppressed", reason }),
    }),
    detectedAt: DateTime.formatIso(row.detectedAt),
  })
);

/** Lists one User's confirmed RecurringSeries in deterministic order in the caller transaction. */
export const listRecurringSeriesInScope = Effect.fn("listRecurringSeriesInScope")(function* (
  userId: UserId
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* SqlSchema.findAll({
    Request: UserId,
    Result: SeriesFlatRow,
    execute: (owner) => sql`
      SELECT ${sql.literal(seriesColumns)} FROM recurring_series
      WHERE user_id = ${owner}
      ORDER BY typical_currency, counterparty, direction, id
    `,
  })(userId).pipe(Effect.orDie);
  return yield* Effect.forEach(rows, seriesFromRow).pipe(Effect.orDie);
});

const CandidateFlatRow = Schema.Struct({
  id: TransactionId,
  amount: Money.fields.amount,
  currency: Money.fields.currency,
  counterparty: Schema.OptionFromNullOr(Counterparty),
  direction: Direction,
  occurredAt: Schema.DateTimeUtcFromDate,
});

/**
 * Reads the whole Transaction history one detection pass compares, oldest first. Detection needs
 * every movement rather than a window, because a yearly charge is only visible across years.
 */
export const listRecurringCandidatesInScope: (
  userId: UserId
) => Effect.Effect<ReadonlyArray<RecurringCandidate>, never, SqlClient.SqlClient> = Effect.fn(
  "listRecurringCandidatesInScope"
)(function* (userId: UserId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* SqlSchema.findAll({
    Request: UserId,
    Result: CandidateFlatRow,
    execute: (owner) => sql`
        SELECT id, amount, currency, counterparty, direction, occurred_at AS "occurredAt"
        FROM transactions
        WHERE user_id = ${owner}
        ORDER BY occurred_at, id
      `,
  })(userId).pipe(Effect.orDie);

  return rows.map((row): RecurringCandidate => ({
    id: row.id,
    money: { amount: row.amount, currency: row.currency },
    counterparty: row.counterparty,
    direction: row.direction,
    occurredAt: row.occurredAt,
  }));
});

const SeriesWriteRow = Schema.Struct({
  userId: UserId,
  counterparty: Counterparty,
  direction: Direction,
  cadence: RecurringSeries.fields.cadence,
  typicalAmount: Money.fields.amount,
  typicalCurrency: Money.fields.currency,
  occurrences: Schema.Array(Schema.toEncoded(TransactionId)),
  firstOccurredAt: Schema.DateTimeUtc,
  lastOccurredAt: Schema.DateTimeUtc,
  suppressionReason: Schema.OptionFromNullOr(RecurringSuppressionReason),
});

const writeRow = (userId: UserId, series: DetectedRecurringSeries): typeof SeriesWriteRow.Type => ({
  userId,
  counterparty: series.counterparty,
  direction: series.direction,
  cadence: series.cadence,
  typicalAmount: series.typicalMoney.amount,
  typicalCurrency: series.typicalMoney.currency,
  occurrences: series.occurrences,
  firstOccurredAt: series.firstOccurredAt,
  lastOccurredAt: series.lastOccurredAt,
  suppressionReason:
    series.announcement.state === "suppressed"
      ? Option.some(series.announcement.reason)
      : Option.none(),
});

/**
 * Records one confirmed series, retaining the identity and first-confirmation instant of a series
 * already known under the same Counterparty, direction, and Currency. Answers whether this call
 * confirmed a series fidy had not recorded before, which is what the announcement trigger reads.
 */
export const upsertRecurringSeriesInScope = Effect.fn("upsertRecurringSeriesInScope")(function* (
  userId: UserId,
  series: DetectedRecurringSeries
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOne({
    Request: SeriesWriteRow,
    Result: Schema.Struct({ ...SeriesFlatRow.fields, inserted: Schema.Boolean }),
    execute: (write) => sql`
      INSERT INTO recurring_series (
        user_id, counterparty, direction, cadence, typical_amount, typical_currency,
        occurrences, first_occurred_at, last_occurred_at, suppression_reason
      ) VALUES (
        ${write.userId}, ${write.counterparty}, ${write.direction}, ${write.cadence},
        ${write.typicalAmount}, ${write.typicalCurrency}, ${write.occurrences}::uuid[],
        ${write.firstOccurredAt}, ${write.lastOccurredAt}, ${write.suppressionReason}
      )
      ON CONFLICT (user_id, counterparty, direction, typical_currency) DO UPDATE SET
        cadence = EXCLUDED.cadence,
        typical_amount = EXCLUDED.typical_amount,
        occurrences = EXCLUDED.occurrences,
        first_occurred_at = EXCLUDED.first_occurred_at,
        last_occurred_at = EXCLUDED.last_occurred_at,
        suppression_reason = EXCLUDED.suppression_reason
      RETURNING ${sql.literal(seriesColumns)}, (xmax = 0) AS inserted
    `,
  })(writeRow(userId, series)).pipe(Effect.orDie);

  return {
    series: yield* seriesFromRow(row).pipe(Effect.orDie),
    confirmedFirstTime: row.inserted,
  };
});

/** Removes the User's recorded series that this detection pass no longer confirms. */
export const deleteUnconfirmedSeriesInScope = Effect.fn("deleteUnconfirmedSeriesInScope")(
  function* (userId: UserId, confirmed: ReadonlyArray<RecurringSeries>) {
    const sql = yield* SqlClient.SqlClient;
    const retained = confirmed.map((series) => series.id);
    yield* (
      retained.length === 0
        ? sql`DELETE FROM recurring_series WHERE user_id = ${userId}`
        : sql`
            DELETE FROM recurring_series
            WHERE user_id = ${userId} AND id <> ALL (${retained}::uuid[])
          `
    ).pipe(Effect.orDie);
  }
);

/**
 * Groups recorded series by explicit Currency in alphabetic order, with the direction-separated
 * cost of one occurrence of each. Nothing is converted, netted, or normalized to a shared period.
 */
export const reportRecurringSeries = Effect.fn("reportRecurringSeries")(function* (userId: UserId) {
  const series = yield* withUserTransaction(userId, listRecurringSeriesInScope(userId));
  const totals = yield* groupMoney({
    inflows: series
      .filter((entry) => entry.direction === "inflow")
      .map((entry) => entry.typicalMoney),
    outflows: series
      .filter((entry) => entry.direction === "outflow")
      .map((entry) => entry.typicalMoney),
  });

  const groups = yield* Effect.forEach(totals, (total) => {
    const denominated = series.filter((entry) => entry.typicalMoney.currency === total.currency);
    // Every Currency in the totals came from a series whose Money is positive, so an empty
    // group would mean grouping and filtering disagreed about the same values.
    return Arr.isReadonlyArrayNonEmpty(denominated)
      ? Effect.succeed(
          RecurringCurrencyGroup.make({
            currency: total.currency,
            series: denominated,
            perOccurrence: {
              currency: total.currency,
              inflow: Money.make(total.inflow),
              outflow: Money.make(total.outflow),
            },
          })
        )
      : Effect.die(new Error("A Currency total must come from at least one RecurringSeries."));
  });

  return { groups } satisfies RecurringSeriesReport;
});
