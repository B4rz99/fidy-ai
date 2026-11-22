import {
  BigDecimal,
  Data,
  DateTime,
  Effect,
  Match,
  Option,
  Result,
  Schema,
  type Types,
} from "effect";
import { allowancePeriod } from "~/core/quotas/operations";
import type { AccessTier } from "~/core/access-tier/contract";
import { Currency, Money, type ReadonlyMoney, encodeMoneyAmount } from "~/core/_shared/money";
import type { CapturedInterpretationContext } from "~/core/interpretation-evidence/contract";
import { Counterparty, TransactionExtraction } from "~/core/transactions/contract";
import {
  type CaptureInterpretation,
  type CaptureInterpretationEvidence,
  type CaptureInterpretationInput,
  type CaptureOccurrence,
  type CaptureProposal,
  type InterpretedStatementRow,
  type NeedsReviewReason,
  type NeedsReviewStatementRow,
  type ParsedStatementRow,
  ReviewDraft,
  type StatementAccounting,
  StatementColumnMapping,
  captureInterpretationRevision,
  forwardedEmailOutstandingCap,
  freeForwardedEmailCap,
  freeForwardedEmailDeferredCap,
  freeMediaSubmissionCap,
} from "./contract";

const captureDateParts = (
  source: Types.ExtractTag<CaptureOccurrence, "LocalDate">
): Readonly<DateTime.DateTime.Parts> => {
  const [year = 0, month = 0, day = 0] = source.date.split("-").map(Number);

  const [hour = 0, minute = 0, second = 0] = Option.getOrElse(source.time, () => "00:00:00")
    .split(":")
    .map(Number);

  return { year, month, day, hour, minute, second, millisecond: 0 };
};

const sameCalendarParts = (
  actual: Readonly<DateTime.DateTime.PartsWithWeekday>,
  expected: Readonly<DateTime.DateTime.Parts>
): boolean =>
  actual.year === expected.year &&
  actual.month === expected.month &&
  actual.day === expected.day &&
  actual.hour === expected.hour &&
  actual.minute === expected.minute &&
  actual.second === expected.second;

const captureOccurrence = (
  occurrence: Option.Option<CaptureOccurrence>,
  context: CapturedInterpretationContext,
  submittedAt: DateTime.Utc
): Option.Option<DateTime.Utc> =>
  Option.match(occurrence, {
    onNone: () => Option.some(submittedAt),
    onSome: Match.type<CaptureOccurrence>().pipe(
      Match.tag("Instant", (source) => Option.some(source.value)),
      Match.tag("LocalDate", (source) => localCaptureOccurrence(source, context)),
      Match.exhaustive
    ),
  });

const localCaptureOccurrence = (
  source: Types.ExtractTag<CaptureOccurrence, "LocalDate">,
  context: CapturedInterpretationContext
): Option.Option<DateTime.Utc> => {
  const parts = captureDateParts(source);

  if (parts.year < 1) return Option.none();

  const date = DateTime.makeZoned(parts, {
    timeZone: context.timeZone,
    adjustForTimeZone: true,
    disambiguation: "reject",
  });

  if (Option.isNone(date)) return Option.none();

  return sameCalendarParts(DateTime.toParts(date.value), parts)
    ? Option.some(DateTime.toUtc(date.value))
    : Option.none();
};

type SingleCaptureProposal = Types.ExtractTag<CaptureProposal, "SingleMovement">;

const Interpretation = Data.taggedEnum<CaptureInterpretation>();

const captureEvidence = (
  currency: Option.Option<Currency>,
  occurrence: Option.Option<CaptureOccurrence>
): CaptureInterpretationEvidence => ({
  currencyBasis: Option.isSome(currency) ? "explicit" : "default",
  dateBasis: Option.isSome(occurrence) ? "explicit" : "submission-date-default",
  revision: captureInterpretationRevision,
});

const interpretSingleCapture = (
  proposal: SingleCaptureProposal,
  input: CaptureInterpretationInput
): CaptureInterpretation => {
  if (proposal.completion !== "completed") {
    return Interpretation.NeedsReview({ reason: "movement-not-completed" });
  }

  if (Option.isNone(proposal.money) || Option.isNone(proposal.direction)) {
    return Interpretation.NeedsReview({ reason: "missing-required-fact" });
  }

  const money = Money.makeOption({
    amount: proposal.money.value.amount,
    currency: Option.getOrElse(proposal.money.value.currency, () => Currency.make("COP")),
  });

  if (Option.isNone(money)) {
    return Interpretation.NeedsReview({ reason: "canonical-validation-failed" });
  }

  const occurrence = captureOccurrence(proposal.occurrence, input.context, input.submittedAt);

  if (Option.isNone(occurrence) || DateTime.isGreaterThan(occurrence.value, input.now)) {
    return Interpretation.NeedsReview({ reason: "invalid-occurrence" });
  }

  const occurredAt = occurrence.value;

  const extraction = TransactionExtraction.makeOption({
    money: money.value,
    direction: proposal.direction.value,
    counterparty: proposal.counterparty,
    occurredAt,
  });

  if (Option.isNone(extraction)) {
    return Interpretation.NeedsReview({ reason: "canonical-validation-failed" });
  }

  return Interpretation.Extracted({
    extraction: extraction.value,
    evidence: captureEvidence(proposal.money.value.currency, proposal.occurrence),
  });
};

export const interpretCapture = (input: CaptureInterpretationInput): CaptureInterpretation =>
  Match.value(input.proposal).pipe(
    Match.tagsExhaustive({
      Unparseable: () => Interpretation.NeedsReview({ reason: "unparseable-material" }),
      MultipleMovements: () => Interpretation.NeedsReview({ reason: "multiple-movements" }),
      SingleMovement: (proposal) => interpretSingleCapture(proposal, input),
    })
  );

type AllowanceWindow = Readonly<{ from: DateTime.Utc; toExclusive: DateTime.Utc }>;

const bogotaAllowancePeriod = (now: DateTime.Utc): AllowanceWindow => {
  const period = allowancePeriod(now);

  return { from: period.startsAt, toExclusive: period.resetsAt };
};

export const emailAllowancePeriod = (now: DateTime.Utc): AllowanceWindow =>
  bogotaAllowancePeriod(now);

export type MediaAdmissionDecision = Data.TaggedEnum<{
  Admit: { readonly consumesFreeAllowance: boolean; readonly remaining: Option.Option<number> };
  QuotaExhausted: { readonly resetsAt: DateTime.Utc };
}>;

export const MediaAdmissionDecision = Data.taggedEnum<MediaAdmissionDecision>();

export const decideMediaAdmission = (
  input: Readonly<{
    access: AccessTier;
    consumed: number;
    now: DateTime.Utc;
  }>
): MediaAdmissionDecision => {
  if (input.access === "pro") {
    return MediaAdmissionDecision.Admit({ consumesFreeAllowance: false, remaining: Option.none() });
  }

  if (input.consumed >= freeMediaSubmissionCap) {
    return MediaAdmissionDecision.QuotaExhausted({
      resetsAt: bogotaAllowancePeriod(input.now).toExclusive,
    });
  }

  return MediaAdmissionDecision.Admit({
    consumesFreeAllowance: true,
    remaining: Option.some(freeMediaSubmissionCap - input.consumed - 1),
  });
};

export type ForwardedEmailProviderFailureReason =
  | "provider-unavailable"
  | "invalid-provider-response"
  | "resource-limit";

type ForwardedEmailProviderFailureIssue = Readonly<{ path: ""; message: string }>;

export const describeForwardedEmailProviderFailure = (
  reason: ForwardedEmailProviderFailureReason
): ForwardedEmailProviderFailureIssue => ({
  path: "",
  message: `Email retrieval stopped safely: ${reason}.`,
});

export type DeferredForwardedEmailActivation = Data.TaggedEnum<{
  Activate: { readonly consumesFreeAllowance: boolean };
  RemainDeferred: { readonly resumeAt: DateTime.Utc };
}>;

export const DeferredForwardedEmailActivation = Data.taggedEnum<DeferredForwardedEmailActivation>();

type DecideDeferredForwardedEmailActivation = (input: {
  readonly access: AccessTier;
  readonly consumed: number;
  readonly now: DateTime.Utc;
  readonly resumeAt: DateTime.Utc;
  readonly nextResumeAt: DateTime.Utc;
}) => DeferredForwardedEmailActivation;

export const decideDeferredForwardedEmailActivation: DecideDeferredForwardedEmailActivation = (
  input
) => {
  if (input.access === "pro") {
    return DeferredForwardedEmailActivation.Activate({ consumesFreeAllowance: false });
  }

  if (DateTime.Order(input.resumeAt, input.now) <= 0 && input.consumed < freeForwardedEmailCap) {
    return DeferredForwardedEmailActivation.Activate({ consumesFreeAllowance: true });
  }

  return DeferredForwardedEmailActivation.RemainDeferred({
    resumeAt: DateTime.Order(input.resumeAt, input.now) <= 0 ? input.nextResumeAt : input.resumeAt,
  });
};

export const forwardedEmailAllowanceRemaining = (input: {
  readonly access: AccessTier;
  readonly consumed: number;
}): Option.Option<number> =>
  input.access === "pro"
    ? Option.none()
    : Option.some(Math.max(0, freeForwardedEmailCap - input.consumed));

type DecideForwardedEmailAdmission = (input: {
  readonly access: AccessTier;
  readonly consumed: number;
  readonly deferred: number;
  readonly outstanding: number;
}) => Readonly<{
  status: "queued" | "deferred" | "backlog-full";
  remaining: Option.Option<number>;
}>;

export const decideForwardedEmailAdmission: DecideForwardedEmailAdmission = (input) => {
  if (input.outstanding >= forwardedEmailOutstandingCap) {
    return {
      status: "backlog-full",
      remaining: input.access === "pro" ? Option.none() : Option.some(0),
    };
  }

  if (input.access === "pro") return { status: "queued", remaining: Option.none() };

  if (input.consumed >= freeForwardedEmailCap) {
    return {
      status: input.deferred >= freeForwardedEmailDeferredCap ? "backlog-full" : "deferred",
      remaining: Option.some(0),
    };
  }

  return {
    status: "queued",
    remaining: Option.some(Math.max(0, freeForwardedEmailCap - input.consumed - 1)),
  };
};

const redactionEmail = "\uE000";

const redactionMoney = "\uE001";

const redactionDigits = "\uE002";

const redactionText = "\uE003";

export const redactEmailCandidate = (content: string): string =>
  content
    .replace(/[\uE000-\uE003]/gu, "")
    .replace(
      /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu,
      redactionEmail
    )
    .replace(/(?:[$€£]|COP\s*\$?)\s*\d[\d.,]*/giu, redactionMoney)
    .replace(/\b\d+\b/gu, redactionDigits)
    .replace(/\p{L}+/gu, redactionText)
    .replaceAll(redactionEmail, "[EMAIL]")
    .replaceAll(redactionMoney, "[MONEY]")
    .replaceAll(redactionDigits, "[DIGITS]")
    .replaceAll(redactionText, "[TEXT]");

const mechanicallyMappedHeaders = ["fecha", "valor", "moneda", "contraparte"];

const mechanicalStatementMapping = Schema.decodeSync(StatementColumnMapping)({
  dateColumn: 0,
  amountColumn: 1,
  currencyColumn: 2,
  counterpartyColumn: 3,
  inflowMarkers: [],
  outflowMarkers: [],
  positiveDirection: "inflow",
  dateFormat: "yyyy-MM-dd",
  decimalSeparator: ".",
});

export const mechanicalMappingFor = (
  headers: ReadonlyArray<string>
): Option.Option<StatementColumnMapping> =>
  headers.length === mechanicallyMappedHeaders.length &&
  headers.every(
    (header, index) => header.trim().toLocaleLowerCase("es-CO") === mechanicallyMappedHeaders[index]
  )
    ? Option.some(mechanicalStatementMapping)
    : Option.none();

export const unmappedStatementRow = (row: ParsedStatementRow): NeedsReviewStatementRow => ({
  outcome: "needs-review",
  recordNumber: row.recordNumber,
  evidence: row.evidence,
  reason: "mapping-unavailable",
  knownMoney: Option.none(),
  suggestions: Option.none(),
  issues: [{ path: "", message: "Statement mapping is unavailable." }],
});

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
  suggestions: Option.none(),
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

const decodeMoney = Effect.fn(function* (
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

    const required = {
      money: {
        amount: encodeMoneyAmount(money.amount),
        currency: money.currency,
      },
      direction: direction.value,
      occurredAt: facts.occurredAt,
    };

    const encoded = Option.match(counterparty, {
      onNone: () => required,
      onSome: (value) => ({ ...required, counterparty: value }),
    });

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

const decodeKnownMoney = Effect.fn(function* (
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
  context: Readonly<{
    timeZone: string;
    decodeCandidate: ExtractionDecoder<Extraction>;
  }>
) => Effect.Effect<InterpretedStatementRow<Extraction>>;

const interpretMappedRow: InterpretRow = (row, mapping, context) =>
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

const safeReviewColumn = (
  row: ParsedStatementRow,
  index: Option.Option<number>
): Option.Option<number> => Option.filter(index, (column) => !unsafeXlsxCells(row, [column]));

const reviewText = (value: string): string =>
  Option.getOrElse(Schema.decodeOption(ReviewDraft.fields.amount)(value), () => "");

const reviewCounterparty = (row: ParsedStatementRow, mapping: StatementColumnMapping): string =>
  Option.getOrElse(
    Option.flatMap(safeReviewColumn(row, mapping.counterpartyColumn), (index) =>
      Schema.decodeOption(Counterparty)((row.fields[index] ?? "").trim())
    ),
    () => ""
  );

const statementReviewDraft = ({
  row,
  mapping,
  timeZone,
  knownMoney,
}: Readonly<{
  row: ParsedStatementRow;
  mapping: StatementColumnMapping;
  timeZone: string;
  knownMoney: Option.Option<Money>;
}>): ReviewDraft => {
  const amountSource = row.fields[mapping.amountColumn] ?? "";

  const amount = Option.flatMap(safeReviewColumn(row, Option.some(mapping.amountColumn)), () =>
    normalizedAmount(amountSource, mapping)
  );

  const currencySafe =
    Option.isNone(mapping.currencyColumn) ||
    Option.isSome(safeReviewColumn(row, mapping.currencyColumn));

  const currency = currencySafe
    ? Option.flatMap(currencyFor(row, mapping), Schema.decodeUnknownOption(Currency))
    : Option.none();

  const date = Option.flatMap(safeReviewColumn(row, Option.some(mapping.dateColumn)), () =>
    parsedDate(row.fields[mapping.dateColumn] ?? "", mapping.dateFormat, timeZone)
  );

  const directionSafe = Option.match(mapping.directionColumn, {
    onNone: () => Option.isSome(amount),
    onSome: (index) => Option.isSome(safeReviewColumn(row, Option.some(index))),
  });

  return {
    amount: Option.match(knownMoney, {
      onSome: (money: ReadonlyMoney) => money.amount.pipe(encodeMoneyAmount, reviewText),
      onNone: () => (Option.isNone(currency) ? reviewText(Option.getOrElse(amount, () => "")) : ""),
    }),
    currency,
    direction: directionSafe ? mappedDirection(row.fields, amountSource, mapping) : Option.none(),
    counterparty: reviewCounterparty(row, mapping),
    occurredAt: Option.match(date, { onNone: () => "", onSome: DateTime.formatIso }),
    categoryId: Option.none(),
    userProvidedFields: [],
  };
};

const interpretRow: InterpretRow = (row, mapping, context) =>
  Effect.gen(function* () {
    const result = yield* interpretMappedRow(row, mapping, context);

    return result.outcome === "accepted"
      ? result
      : {
          ...result,
          suggestions: Option.some(
            statementReviewDraft({
              row,
              mapping,
              timeZone: context.timeZone,
              knownMoney: result.knownMoney,
            })
          ),
        };
  });

export const interpretStatementRows = Effect.fn(function* <Extraction>(
  input: Readonly<{
    rows: ReadonlyArray<ParsedStatementRow>;
    mapping: StatementColumnMapping;
    timeZone: string;
  }>,
  decodeCandidate: ExtractionDecoder<Extraction>
) {
  const outcomes = yield* Effect.forEach(input.rows, (row: Readonly<ParsedStatementRow>) =>
    interpretRow(row, input.mapping, {
      timeZone: input.timeZone,
      decodeCandidate,
    })
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
