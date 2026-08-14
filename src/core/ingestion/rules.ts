import { BigDecimal, DateTime, Effect, Option, Result, Schema } from "effect";
import { type Currency, Money, encodeMoneyAmount } from "~/core/_shared/money";
import {
  type InterpretedStatementRow,
  type NeedsReviewReason,
  type NeedsReviewStatementRow,
  type ParsedStatementRow,
  type StatementAccounting,
  type StatementColumnMapping,
} from "./model";

type StatementDirection = "inflow" | "outflow";
type ExtractionDecoder<Extraction> = (
  candidate: Schema.Json
) => Effect.Effect<Extraction, Schema.SchemaError, never>;

const oppositeDirection = (direction: StatementDirection): StatementDirection =>
  direction === "inflow" ? "outflow" : "inflow";

const normalizeMarker = (value: string): string => value.trim().toLocaleUpperCase("en-US");

const mappedDirection = (
  fields: ReadonlyArray<string>,
  amountText: string,
  mapping: StatementColumnMapping
): Option.Option<StatementDirection> =>
  Option.match(mapping.directionColumn, {
    onNone: () =>
      Option.some(
        amountText.startsWith("-")
          ? oppositeDirection(mapping.positiveDirection)
          : mapping.positiveDirection
      ),
    onSome: (index) => {
      const marker = normalizeMarker(fields[index] ?? "");
      if (mapping.inflowMarkers.some((candidate) => normalizeMarker(candidate) === marker)) {
        return Option.some("inflow");
      }
      if (mapping.outflowMarkers.some((candidate) => normalizeMarker(candidate) === marker)) {
        return Option.some("outflow");
      }
      return Option.none();
    },
  });

type NormalizeAmount = (source: string, mapping: StatementColumnMapping) => Option.Option<string>;

const normalizedAmount: NormalizeAmount = (source, mapping) => {
  let value = source.trim();
  value = Option.match(mapping.groupingSeparator, {
    onNone: () => value,
    onSome: (separator) => value.replaceAll(separator, ""),
  });
  if (mapping.decimalSeparator === ",") value = value.replace(",", ".");
  value = value.replace(/^[-+]/u, "");
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) ? Option.some(value) : Option.none();
};

type DateFormat = StatementColumnMapping["dateFormat"];
type DateParts = Readonly<{ year: number; month: number; day: number }>;
type DatePartInput = Readonly<{
  format: DateFormat;
  first: number;
  second: number;
  third: number;
}>;
type ParseDateParts = (input: DatePartInput) => DateParts;
type ParseDate = (
  value: string,
  format: DateFormat,
  timeZone: string
) => Option.Option<DateTime.Utc>;

const dateParts: ParseDateParts = (input) => {
  const { format, first, second, third } = input;
  if (format === "yyyy-MM-dd") return { year: first, month: second, day: third };
  if (format === "dd/MM/yyyy") return { year: third, month: second, day: first };
  return { year: third, month: first, day: second };
};

const parsedDate: ParseDate = (value, format, timeZone) => {
  const match = /^(\d{2,4})[-/](\d{2})[-/](\d{2,4})$/u.exec(value.trim());
  if (match === null) return Option.none();
  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = Number(match[3]);
  const parts = dateParts({ format, first, second, third });
  const date = DateTime.makeZoned(parts, { timeZone, adjustForTimeZone: true });
  if (Option.isNone(date)) return Option.none();
  const actual = DateTime.toParts(date.value);
  const expectedDateKey = [parts.year, parts.month, parts.day].join("-");
  const actualDateKey = [actual.year, actual.month, actual.day].join("-");
  return actualDateKey === expectedDateKey
    ? Option.some(DateTime.toUtc(date.value))
    : Option.none();
};

type ReviewInput = Readonly<{
  reason: NeedsReviewReason;
  knownMoney: Option.Option<Money>;
  message: string;
}>;

const review = (row: ParsedStatementRow, input: ReviewInput): NeedsReviewStatementRow => ({
  outcome: "needs-review",
  recordNumber: row.recordNumber,
  reason: input.reason,
  knownMoney: input.knownMoney,
  issues: [{ path: "", message: input.message }],
  evidence: row.evidence,
});

const currencyFor = (
  row: ParsedStatementRow,
  mapping: StatementColumnMapping
): Option.Option<string> =>
  Option.match(mapping.currencyColumn, {
    onNone: () => mapping.currencyLiteral,
    onSome: (index) =>
      Option.liftPredicate((value: string) => value.length > 0)(
        (row.fields[index] ?? "").trim().toLocaleUpperCase("en-US")
      ),
  });

const decodeMoney = Effect.fn("decodeStatementMoney")(function* (
  row: ParsedStatementRow,
  mapping: StatementColumnMapping,
  amount: string
) {
  const currency = currencyFor(row, mapping);
  if (Option.isNone(currency)) {
    return review(row, {
      reason: "ambiguous-currency",
      knownMoney: Option.none(),
      message: "The row has no recognized Currency.",
    });
  }
  const result = yield* Effect.result(
    Schema.decodeUnknownEffect(Money)({ amount, currency: currency.value })
  );
  if (Result.isFailure(result)) {
    return review(row, {
      reason: "canonical-validation-failed",
      knownMoney: Option.none(),
      message: "The row's Money failed canonical Currency or precision validation.",
    });
  }
  return result.success;
});

type DecodeExtraction = <Extraction>(decodeCandidate: ExtractionDecoder<Extraction>) => (
  row: ParsedStatementRow,
  mapping: StatementColumnMapping,
  facts: Readonly<{
    amountSource: string;
    occurredAt: string;
    moneyAmount: string;
    currency: Currency;
  }>
) => Effect.Effect<InterpretedStatementRow<Extraction>>;

const decodeExtraction: DecodeExtraction = (decodeCandidate) => (row, mapping, facts) =>
  Effect.gen(function* () {
    const money = Money.make({
      amount: BigDecimal.fromStringUnsafe(facts.moneyAmount),
      currency: facts.currency,
    });
    const direction = mappedDirection(row.fields, facts.amountSource, mapping);
    if (Option.isNone(direction)) {
      return review(row, {
        reason: "ambiguous-direction",
        knownMoney: Option.some(money),
        message: "The row's direction marker is not recognized by this statement format.",
      });
    }
    const counterparty = Option.flatMap(mapping.counterpartyColumn, (index) =>
      Option.liftPredicate((value: string) => value.length > 0)((row.fields[index] ?? "").trim())
    );
    const encoded = {
      money: { amount: encodeMoneyAmount(money.amount), currency: money.currency },
      direction: direction.value,
      occurredAt: facts.occurredAt,
      ...(Option.isSome(counterparty) ? { counterparty: counterparty.value } : {}),
    };
    const result = yield* Effect.result(decodeCandidate(encoded));
    if (Result.isFailure(result)) {
      return review(row, {
        reason: "canonical-validation-failed",
        knownMoney: Option.some(money),
        message: "The mechanically extracted facts failed canonical Transaction validation.",
      });
    }
    return {
      outcome: "accepted",
      recordNumber: row.recordNumber,
      extraction: result.success,
      evidence: row.evidence,
    };
  });

type FinancialCell = Readonly<{
  cellType: "blank" | "string" | "number" | "date" | "boolean" | "error";
  formula: Option.Option<string>;
}>;

const unsafeFinancialCell = (cell: FinancialCell): boolean =>
  ["boolean", "error"].includes(cell.cellType) || Option.isSome(cell.formula);

const unsafeXlsxCells = (row: ParsedStatementRow, indexes: ReadonlyArray<number>): boolean => {
  if (row.evidence.sourceFormat !== "xlsx") return false;
  const cells = row.evidence.cells;
  return indexes.some((index) => {
    const cell = cells[index];
    return cell !== undefined && unsafeFinancialCell(cell);
  });
};

const decodeKnownMoney = Effect.fn("decodeKnownStatementMoney")(function* (
  row: ParsedStatementRow,
  mapping: StatementColumnMapping
) {
  const moneyIndexes = [mapping.amountColumn, ...Option.toArray(mapping.currencyColumn)];
  if (unsafeXlsxCells(row, moneyIndexes)) {
    return review(row, {
      reason: "malformed-source-row",
      knownMoney: Option.none(),
      message: "A mapped Money cell is a formula, boolean, or spreadsheet error.",
    });
  }
  const amountSource = row.fields[mapping.amountColumn] ?? "";
  const amount = normalizedAmount(amountSource, mapping);
  if (Option.isNone(amount)) {
    return review(row, {
      reason: "missing-required-fact",
      knownMoney: Option.none(),
      message: "The row is missing a valid amount.",
    });
  }
  const money = yield* decodeMoney(row, mapping, amount.value);
  return { money, amountSource };
});

type InterpretRow = <Extraction>(
  row: ParsedStatementRow,
  mapping: StatementColumnMapping,
  context: Readonly<{ timeZone: string; decodeCandidate: ExtractionDecoder<Extraction> }>
) => Effect.Effect<InterpretedStatementRow<Extraction>>;

const interpretRow: InterpretRow = (row, mapping, context) =>
  Effect.gen(function* () {
    const known = yield* decodeKnownMoney(row, mapping);
    if ("outcome" in known) return known;
    if ("outcome" in known.money) return known.money;

    const remainingIndexes = [mapping.dateColumn, ...Option.toArray(mapping.directionColumn)];
    if (unsafeXlsxCells(row, remainingIndexes)) {
      return review(row, {
        reason: "malformed-source-row",
        knownMoney: Option.some(known.money),
        message: "A mapped date or direction cell is a formula, boolean, or spreadsheet error.",
      });
    }
    const date = parsedDate(
      row.fields[mapping.dateColumn] ?? "",
      mapping.dateFormat,
      context.timeZone
    );
    if (Option.isNone(date)) {
      return review(row, {
        reason: "missing-required-fact",
        knownMoney: Option.some(known.money),
        message: "The row is missing a valid date.",
      });
    }
    return yield* decodeExtraction(context.decodeCandidate)(row, mapping, {
      amountSource: known.amountSource,
      occurredAt: DateTime.formatIso(date.value),
      moneyAmount: encodeMoneyAmount(known.money.amount),
      currency: known.money.currency,
    });
  });

/**
 * Mechanically interprets every parser row and proves the conservation equation. The caller owns
 * the canonical decoder for the entity it will persist; a decoding failure becomes review.
 */
export const interpretStatementRows = Effect.fn("interpretStatementRows")(function* <Extraction>(
  input: Readonly<{
    rows: ReadonlyArray<ParsedStatementRow>;
    mapping: StatementColumnMapping;
    timeZone: string;
  }>,
  decodeCandidate: ExtractionDecoder<Extraction>
) {
  const outcomes = yield* Effect.forEach(input.rows, (row: Readonly<ParsedStatementRow>) =>
    interpretRow(row, input.mapping, { timeZone: input.timeZone, decodeCandidate })
  );
  const counts: Record<InterpretedStatementRow<Extraction>["outcome"], number> = {
    accepted: 0,
    "needs-review": 0,
  };
  for (const outcome of outcomes) counts[outcome.outcome] += 1;
  const accounting: StatementAccounting = {
    inputRows: input.rows.length,
    acceptedRows: counts.accepted,
    needsReviewRows: counts["needs-review"],
  };
  return { outcomes, accounting };
});
