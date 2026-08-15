import { expect, it } from "@effect/vitest";
import { BigDecimal, DateTime, Effect, Option, Result, Schema } from "effect";
import { Currency, Money, type ReadonlyMoney } from "~/core/_shared/money";
import {
  type InterpretedStatementRow,
  ParsedStatementRow,
  StatementAccounting,
  StatementColumnMapping,
  type XlsxCellEvidence,
} from "./model";
import { interpretStatementRows } from "./rules";

const TestExtraction = Schema.Struct({
  money: Money,
  counterparty: Schema.OptionFromOptionalKey(
    Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(120))
  ),
  direction: Schema.Literals(["inflow", "outflow"]),
  occurredAt: Schema.DateTimeUtcFromString,
}).check(
  Schema.makeFilter((extraction: Readonly<{ money: ReadonlyMoney }>) =>
    BigDecimal.isPositive(extraction.money.amount) ? undefined : "Expected positive Money"
  )
);
type TestExtraction = typeof TestExtraction.Type;

const interpretCanonicalRows = (
  input: Parameters<typeof interpretStatementRows>[0]
): Effect.Effect<
  Readonly<{
    outcomes: ReadonlyArray<InterpretedStatementRow<TestExtraction>>;
    accounting: StatementAccounting;
  }>
> => interpretStatementRows(input, Schema.decodeUnknownEffect(TestExtraction));

const csvRow = (recordNumber: number, fields: ReadonlyArray<string>): ParsedStatementRow => ({
  recordNumber,
  fields,
  evidence: {
    sourceFormat: "csv",
    recordNumber,
    startLine: recordNumber + 1,
    endLine: recordNumber + 1,
    rawRecord: fields.join(";"),
    fields,
  },
});

const xlsxCell = (
  address: string,
  value: string,
  formula: Option.Option<string>
): XlsxCellEvidence => ({
  address,
  cellType: "number",
  value,
  formattedText: Option.none<string>(),
  numberFormat: Option.none<string>(),
  formula,
});

it("rejects non-conserved accounting", () => {
  expect(
    Schema.is(StatementAccounting)({ inputRows: 1, acceptedRows: 1, needsReviewRows: 1 })
  ).toBe(false);
});

it("rejects contradictory duplicated CSV row facts", () => {
  expect(Schema.is(ParsedStatementRow)({ ...csvRow(1, ["a"]), recordNumber: 2 })).toBe(false);
});

it("rejects contradictory mapping strategies", () => {
  const base = {
    dateColumn: 0,
    amountColumn: 1,
    counterpartyColumn: Option.none(),
    directionColumn: Option.none(),
    inflowMarkers: [],
    outflowMarkers: [],
    positiveDirection: "outflow" as const,
    dateFormat: "yyyy-MM-dd" as const,
    decimalSeparator: "." as const,
    groupingSeparator: Option.none(),
  };
  expect(
    Schema.is(StatementColumnMapping)({
      ...base,
      currencyColumn: Option.none(),
      currencyLiteral: Option.none(),
    })
  ).toBe(false);
  expect(
    Schema.is(StatementColumnMapping)({
      ...base,
      currencyColumn: Option.none(),
      currencyLiteral: Option.some(Currency.make("COP")),
      inflowMarkers: ["CREDIT"],
    })
  ).toBe(false);
  expect(
    Schema.is(StatementColumnMapping)({
      ...base,
      currencyColumn: Option.none(),
      currencyLiteral: Option.some(Currency.make("COP")),
      outflowMarkers: ["DEBIT"],
    })
  ).toBe(false);

  const decodeMapping = Schema.decodeUnknownResult(Schema.toType(StatementColumnMapping));
  const invalidCurrency = decodeMapping({
    ...base,
    currencyColumn: Option.none(),
    currencyLiteral: Option.none(),
  });
  expect(Result.isFailure(invalidCurrency) ? String(invalidCurrency.failure) : "").toContain(
    "currencyColumn"
  );
  const invalidDirection = decodeMapping({
    ...base,
    currencyColumn: Option.none(),
    currencyLiteral: Option.some(Currency.make("COP")),
    outflowMarkers: ["DEBIT"],
  });
  expect(Result.isFailure(invalidDirection) ? String(invalidDirection.failure) : "").toContain(
    "directionColumn"
  );
});

it.effect("accounts for every row through the canonical Transaction and Money gate", () =>
  Effect.gen(function* () {
    const mapping = StatementColumnMapping.make({
      dateColumn: 0,
      amountColumn: 1,
      counterpartyColumn: Option.some(2),
      currencyColumn: Option.none(),
      currencyLiteral: Option.some(Currency.make("COP")),
      directionColumn: Option.some(3),
      inflowMarkers: ["CREDIT"],
      outflowMarkers: ["DEBIT"],
      positiveDirection: "inflow",
      dateFormat: "dd/MM/yyyy",
      decimalSeparator: ",",
      groupingSeparator: Option.some("."),
    });
    const interpreted = yield* interpretCanonicalRows({
      rows: [
        csvRow(1, ["05/02/2026", "25.000", "Mercado", "DEBIT"]),
        csvRow(2, ["06/02/2026", "10,555", "Taxi", "DEBIT"]),
        csvRow(3, ["", "8.000", "Panadería", "DEBIT"]),
      ],
      mapping,
      timeZone: "America/Bogota",
    });

    expect(interpreted.accounting).toEqual({
      inputRows: 3,
      acceptedRows: 1,
      needsReviewRows: 2,
    });
    expect(interpreted.outcomes).toMatchObject([
      { outcome: "accepted" },
      { outcome: "needs-review" },
      { outcome: "needs-review" },
    ]);

    const accepted = Option.getOrThrow(Option.fromUndefinedOr(interpreted.outcomes[0]));
    if (accepted.outcome !== "accepted") return;
    expect(accepted.extraction.money.currency).toBe("COP");
    expect(
      BigDecimal.equals(accepted.extraction.money.amount, BigDecimal.fromStringUnsafe("25000"))
    ).toBe(true);
    expect(accepted.extraction.direction).toBe("outflow");
    expect(accepted.extraction.occurredAt).toEqual(
      DateTime.toUtc(
        DateTime.makeZonedUnsafe("2026-02-05", {
          timeZone: "America/Bogota",
          adjustForTimeZone: true,
        })
      )
    );

    const overPrecision = Option.getOrThrow(Option.fromUndefinedOr(interpreted.outcomes[1]));
    if (overPrecision.outcome === "needs-review") {
      expect(overPrecision.reason).toBe("canonical-validation-failed");
      expect(Option.isSome(overPrecision.knownMoney)).toBe(false);
    }
    expect(interpreted.outcomes[2]).toMatchObject({
      outcome: "needs-review",
      reason: "missing-required-fact",
      issues: [{ path: "", message: "The row is missing a valid date." }],
    });
  })
);

it.effect(
  "handles signed amounts, literal-free currencies, date layouts, and unknown markers",
  () =>
    Effect.gen(function* () {
      const signedMapping = StatementColumnMapping.make({
        dateColumn: 0,
        amountColumn: 1,
        counterpartyColumn: Option.none(),
        currencyColumn: Option.some(2),
        currencyLiteral: Option.none(),
        directionColumn: Option.none(),
        inflowMarkers: [],
        outflowMarkers: [],
        positiveDirection: "inflow",
        dateFormat: "MM/dd/yyyy",
        decimalSeparator: ".",
        groupingSeparator: Option.none(),
      });
      const signed = yield* interpretCanonicalRows({
        rows: [
          csvRow(1, ["02/05/2026", "+25.00", "cop"]),
          csvRow(2, ["02/06/2026", "-8", "USD"]),
          csvRow(3, ["02/07/2026", "1", ""]),
          csvRow(4, ["not-a-date", "1", "COP"]),
          csvRow(5, ["02/08/2026", "01", "COP"]),
          csvRow(6, ["02/30/2026", "1", "COP"]),
          csvRow(7, ["02/08/2026", "0", "COP"]),
        ],
        mapping: signedMapping,
        timeZone: "America/Bogota",
      });
      expect(signed.outcomes).toMatchObject([
        { outcome: "accepted", extraction: { direction: "inflow" } },
        { outcome: "accepted", extraction: { direction: "outflow" } },
        { outcome: "needs-review", reason: "ambiguous-currency" },
        { outcome: "needs-review", reason: "missing-required-fact" },
        { outcome: "needs-review", reason: "missing-required-fact" },
        { outcome: "needs-review", reason: "missing-required-fact" },
        { outcome: "needs-review", reason: "canonical-validation-failed" },
      ]);

      const markerMapping = StatementColumnMapping.make({
        ...signedMapping,
        counterpartyColumn: Option.some(3),
        currencyColumn: Option.some(2),
        directionColumn: Option.some(4),
        inflowMarkers: ["credit", "cash in", "ß"],
        outflowMarkers: ["debit"],
        dateFormat: "yyyy-MM-dd",
      });
      const marked = yield* interpretCanonicalRows({
        rows: [
          csvRow(1, ["2026-02-05", "25", "COP", "", " CREDIT "]),
          csvRow(2, ["2026-02-05", "25", "COP", "Shop", "unknown"]),
          csvRow(3, ["2026-02-05", "25", "INVALID", "Shop", "DEBIT"]),
          csvRow(4, ["2026-02-05", "25", "COP", " Shop ", "DEBIT"]),
          csvRow(5, ["2026-02-05", "25", "COP", "", "ss"]),
        ],
        mapping: markerMapping,
        timeZone: "America/Bogota",
      });
      expect(marked.outcomes).toMatchObject([
        { outcome: "accepted", extraction: { direction: "inflow" } },
        { outcome: "needs-review", reason: "ambiguous-direction" },
        { outcome: "needs-review", reason: "canonical-validation-failed" },
        {
          outcome: "accepted",
          extraction: { direction: "outflow", counterparty: Option.some("Shop") },
        },
        { outcome: "accepted", extraction: { direction: "inflow" } },
      ]);
    })
);

it.effect("distinguishes whitespace and anchored parsing from malformed values", () =>
  Effect.gen(function* () {
    const mapping = StatementColumnMapping.make({
      dateColumn: 0,
      amountColumn: 1,
      counterpartyColumn: Option.none(),
      currencyColumn: Option.some(2),
      currencyLiteral: Option.none(),
      directionColumn: Option.none(),
      inflowMarkers: [],
      outflowMarkers: [],
      positiveDirection: "inflow",
      dateFormat: "MM/dd/yyyy",
      decimalSeparator: ".",
      groupingSeparator: Option.none(),
    });
    const interpreted = yield* interpretCanonicalRows({
      rows: [
        csvRow(1, [" 02/09/2026 ", " 2.50 ", " COP "]),
        csvRow(2, ["02/09/2026 trailing", "1", "COP"]),
        csvRow(3, ["prefix 02/09/2026", "1", "COP"]),
        csvRow(4, ["02/09/2026", "1,2", "COP"]),
        csvRow(5, ["02/09/2026", "1-2", "COP"]),
      ],
      mapping,
      timeZone: "America/Bogota",
    });

    expect(interpreted.outcomes).toMatchObject([
      { outcome: "accepted", extraction: { money: { currency: "COP" } } },
      { outcome: "needs-review", reason: "missing-required-fact" },
      { outcome: "needs-review", reason: "missing-required-fact" },
      { outcome: "needs-review", reason: "missing-required-fact" },
      { outcome: "needs-review", reason: "missing-required-fact" },
    ]);
    const accepted = interpreted.outcomes[0];
    if (accepted?.outcome === "accepted") {
      expect(accepted.extraction.occurredAt).toEqual(
        DateTime.toUtc(
          DateTime.makeZonedUnsafe("2026-02-09", {
            timeZone: "America/Bogota",
            adjustForTimeZone: true,
          })
        )
      );
    }
  })
);

it.effect("rejects a local calendar date skipped by its time zone", () =>
  Effect.gen(function* () {
    const mapping = StatementColumnMapping.make({
      dateColumn: 0,
      amountColumn: 1,
      counterpartyColumn: Option.none(),
      currencyColumn: Option.none(),
      currencyLiteral: Option.some(Currency.make("COP")),
      directionColumn: Option.none(),
      inflowMarkers: [],
      outflowMarkers: [],
      positiveDirection: "inflow",
      dateFormat: "yyyy-MM-dd",
      decimalSeparator: ".",
      groupingSeparator: Option.none(),
    });
    const interpreted = yield* interpretCanonicalRows({
      rows: [csvRow(1, ["2011-12-30", "1"])],
      mapping,
      timeZone: "Pacific/Apia",
    });

    expect(interpreted.outcomes).toMatchObject([
      { outcome: "needs-review", reason: "missing-required-fact" },
    ]);
  })
);

it.effect("inspects mapped currency cells before decoding", () =>
  Effect.gen(function* () {
    const mapping = StatementColumnMapping.make({
      dateColumn: 0,
      amountColumn: 1,
      counterpartyColumn: Option.none(),
      currencyColumn: Option.some(2),
      currencyLiteral: Option.none(),
      directionColumn: Option.none(),
      inflowMarkers: [],
      outflowMarkers: [],
      positiveDirection: "inflow",
      dateFormat: "yyyy-MM-dd",
      decimalSeparator: ".",
      groupingSeparator: Option.none(),
    });
    const interpreted = yield* interpretCanonicalRows({
      rows: [
        {
          recordNumber: 1,
          fields: ["2020-02-05", "25000", "COP"],
          evidence: {
            sourceFormat: "xlsx",
            sheetName: "Statement",
            sheetIndex: 0,
            rowNumber: 2,
            hidden: false,
            cells: [
              xlsxCell("A2", "2020-02-05", Option.none()),
              xlsxCell("B2", "25000", Option.none()),
              { ...xlsxCell("C2", "COP", Option.none()), cellType: "boolean" },
            ],
          },
        },
      ],
      mapping,
      timeZone: "America/Bogota",
    });

    expect(interpreted.outcomes).toMatchObject([
      {
        outcome: "needs-review",
        reason: "malformed-source-row",
        issues: [
          {
            path: "",
            message: "A mapped Money cell is a formula, boolean, or spreadsheet error.",
          },
        ],
      },
    ]);
  })
);

it.effect("covers opposite signed direction and absent mapped cells", () =>
  Effect.gen(function* () {
    const signedMapping = StatementColumnMapping.make({
      dateColumn: 0,
      amountColumn: 1,
      counterpartyColumn: Option.some(10),
      currencyColumn: Option.none(),
      currencyLiteral: Option.some(Currency.make("COP")),
      directionColumn: Option.none(),
      inflowMarkers: [],
      outflowMarkers: [],
      positiveDirection: "outflow",
      dateFormat: "yyyy-MM-dd",
      decimalSeparator: ".",
      groupingSeparator: Option.none(),
    });
    const signed = yield* interpretCanonicalRows({
      rows: [csvRow(1, ["2026-02-05", "1"]), csvRow(2, ["2026-02-05", "-1"])],
      mapping: signedMapping,
      timeZone: "America/Bogota",
    });
    expect(signed.outcomes).toMatchObject([
      { outcome: "accepted", extraction: { direction: "outflow" } },
      { outcome: "accepted", extraction: { direction: "inflow" } },
    ]);

    const absentMarker = yield* interpretCanonicalRows({
      rows: [csvRow(1, ["2026-02-05", "1"])],
      mapping: StatementColumnMapping.make({
        ...signedMapping,
        directionColumn: Option.some(10),
        inflowMarkers: ["CREDIT"],
      }),
      timeZone: "America/Bogota",
    });
    expect(absentMarker.outcomes).toMatchObject([
      { outcome: "needs-review", reason: "ambiguous-direction" },
    ]);

    const absentCurrency = yield* interpretCanonicalRows({
      rows: [
        {
          recordNumber: 1,
          fields: ["2026-02-05", "1"],
          evidence: {
            sourceFormat: "xlsx",
            sheetName: "Statement",
            sheetIndex: 0,
            rowNumber: 2,
            hidden: false,
            cells: [],
          },
        },
      ],
      mapping: StatementColumnMapping.make({
        ...signedMapping,
        currencyColumn: Option.some(10),
        currencyLiteral: Option.none(),
        directionColumn: Option.some(11),
      }),
      timeZone: "America/Bogota",
    });
    expect(absentCurrency.outcomes).toMatchObject([
      { outcome: "needs-review", reason: "ambiguous-currency" },
    ]);

    const invalidZone = yield* interpretCanonicalRows({
      rows: [csvRow(1, ["2026-02-05", "1"])],
      mapping: signedMapping,
      timeZone: "Not/AZone",
    });
    expect(invalidZone.outcomes).toMatchObject([
      {
        outcome: "needs-review",
        reason: "missing-required-fact",
        knownMoney: { _tag: "Some", value: { currency: "COP" } },
      },
    ]);
  })
);

it.effect("routes formula-backed financial cells to review without using cached values", () =>
  Effect.gen(function* () {
    const mapping = StatementColumnMapping.make({
      dateColumn: 0,
      amountColumn: 1,
      counterpartyColumn: Option.some(2),
      currencyColumn: Option.none(),
      currencyLiteral: Option.some(Currency.make("COP")),
      directionColumn: Option.some(3),
      inflowMarkers: ["CREDIT"],
      outflowMarkers: ["DEBIT"],
      positiveDirection: "inflow",
      dateFormat: "yyyy-MM-dd",
      decimalSeparator: ".",
      groupingSeparator: Option.none(),
    });
    const financialCellCases: ReadonlyArray<
      readonly [
        XlsxCellEvidence["cellType"],
        XlsxCellEvidence["cellType"],
        XlsxCellEvidence["cellType"],
        Option.Option<string>,
      ]
    > = [
      ["number", "number", "number", Option.some("12500*2")],
      ["boolean", "number", "number", Option.none()],
      ["number", "error", "number", Option.none()],
      ["number", "number", "boolean", Option.none()],
    ];
    const rows = financialCellCases.map(
      ([dateType, amountType, directionType, formula], index): ParsedStatementRow => ({
        recordNumber: index + 1,
        fields: ["2020-02-05", "25000", "Mercado", "DEBIT"],
        evidence: {
          sourceFormat: "xlsx",
          sheetName: "Statement",
          sheetIndex: 0,
          rowNumber: index + 2,
          hidden: false,
          cells: [
            { ...xlsxCell("A2", "2020-02-05", Option.none()), cellType: dateType },
            { ...xlsxCell("B2", "25000", formula), cellType: amountType },
            xlsxCell("C2", "Mercado", Option.none()),
            { ...xlsxCell("D2", "DEBIT", Option.none()), cellType: directionType },
          ],
        },
      })
    );
    const safeRow: ParsedStatementRow = {
      recordNumber: 5,
      fields: ["2020-02-05", "25000", "Mercado", "DEBIT"],
      evidence: {
        sourceFormat: "xlsx",
        sheetName: "Statement",
        sheetIndex: 0,
        rowNumber: 6,
        hidden: false,
        cells: [
          xlsxCell("A6", "2020-02-05", Option.none()),
          xlsxCell("B6", "25000", Option.none()),
        ],
      },
    };
    const interpreted = yield* interpretCanonicalRows({
      rows: [...rows, safeRow],
      mapping,
      timeZone: "America/Bogota",
    });

    expect(interpreted.accounting).toEqual({
      inputRows: 5,
      acceptedRows: 1,
      needsReviewRows: 4,
    });
    expect(interpreted.outcomes[0]).toMatchObject({
      outcome: "needs-review",
      reason: "malformed-source-row",
    });
  })
);
