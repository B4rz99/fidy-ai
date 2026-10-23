import { expect, it } from "@effect/vitest";
import { BigDecimal, DateTime, Effect, Option, Result, Schema, Tracer } from "effect";
import { Currency, Money, type ReadonlyMoney } from "~/core/_shared/money";
import {
  type InterpretedStatementRow,
  ParsedStatementRow,
  type StatementAccounting,
  StatementColumnMapping,
  type XlsxCellEvidence,
} from "./contract";
import {
  decideDeferredForwardedEmailActivation,
  decideForwardedEmailAdmission,
  describeForwardedEmailProviderFailure,
  emailAllowancePeriod,
  forwardedEmailAllowanceRemaining,
  interpretStatementRows,
  mechanicalMappingFor,
  redactEmailCandidate,
  unmappedStatementRow,
} from "./operations";

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

const copDebitMapping = (): StatementColumnMapping =>
  StatementColumnMapping.make({
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

it("preserves provider failure classification in visible review evidence", () => {
  expect(describeForwardedEmailProviderFailure("invalid-provider-response")).toEqual({
    path: "",
    message: "Email retrieval stopped safely: invalid-provider-response.",
  });
});

it("activates deferred email from a locked allowance snapshot", () => {
  const now = DateTime.makeUnsafe("2026-09-15T12:00:00Z");
  const resumeAt = DateTime.makeUnsafe("2026-09-01T05:00:00Z");
  const nextResumeAt = DateTime.makeUnsafe("2026-10-01T05:00:00Z");
  expect(
    decideDeferredForwardedEmailActivation({
      access: "free",
      consumed: 29,
      now,
      resumeAt,
      nextResumeAt,
    })
  ).toEqual({ _tag: "Activate", consumesFreeAllowance: true });
  expect(
    decideDeferredForwardedEmailActivation({
      access: "free",
      consumed: 30,
      now,
      resumeAt,
      nextResumeAt,
    })
  ).toEqual({ _tag: "RemainDeferred", resumeAt: nextResumeAt });
  expect(
    decideDeferredForwardedEmailActivation({
      access: "pro",
      consumed: 30,
      now,
      resumeAt: nextResumeAt,
      nextResumeAt,
    })
  ).toEqual({ _tag: "Activate", consumesFreeAllowance: false });
});

it("changes deferred email eligibility at the exact reset instant", () => {
  const now = DateTime.makeUnsafe("2026-09-01T05:00:00Z");
  const nextResumeAt = DateTime.makeUnsafe("2026-10-01T05:00:00Z");
  for (const consumed of [0, 30]) {
    const input = { access: "free" as const, consumed, now, nextResumeAt };
    const future = DateTime.add(now, { milliseconds: 1 });
    expect(decideDeferredForwardedEmailActivation({ ...input, resumeAt: future })).toEqual({
      _tag: "RemainDeferred",
      resumeAt: future,
    });
    expect(decideDeferredForwardedEmailActivation({ ...input, resumeAt: now })).toEqual(
      consumed === 0
        ? { _tag: "Activate", consumesFreeAllowance: true }
        : { _tag: "RemainDeferred", resumeAt: nextResumeAt }
    );
  }
  expect(
    decideForwardedEmailAdmission({ access: "free", consumed: 0, deferred: 0, outstanding: 0 })
  ).toEqual({
    status: "queued",
    remaining: Option.some(29),
  });
});

it("applies the Free forwarded-email allowance to a Bogota calendar month", () => {
  const period = emailAllowancePeriod(DateTime.makeUnsafe("2026-09-01T04:59:59Z"));
  expect(DateTime.formatIso(period.from)).toBe("2026-08-01T05:00:00.000Z");
  expect(DateTime.formatIso(period.toExclusive)).toBe("2026-09-01T05:00:00.000Z");
  expect(
    decideForwardedEmailAdmission({ access: "free", consumed: 29, deferred: 0, outstanding: 49 })
  ).toEqual({
    status: "queued",
    remaining: Option.some(0),
  });
  expect(
    decideForwardedEmailAdmission({ access: "free", consumed: 30, deferred: 0, outstanding: 50 })
  ).toEqual({
    status: "deferred",
    remaining: Option.some(0),
  });
  expect(
    decideForwardedEmailAdmission({ access: "free", consumed: 30, deferred: 50, outstanding: 99 })
  ).toEqual({
    status: "backlog-full",
    remaining: Option.some(0),
  });
  expect(
    decideForwardedEmailAdmission({ access: "free", consumed: 30, deferred: 0, outstanding: 100 })
  ).toEqual({
    status: "backlog-full",
    remaining: Option.some(0),
  });
  expect(
    decideForwardedEmailAdmission({ access: "pro", consumed: 500, deferred: 0, outstanding: 99 })
  ).toEqual({
    status: "queued",
    remaining: Option.none(),
  });
  expect(
    decideForwardedEmailAdmission({ access: "pro", consumed: 500, deferred: 0, outstanding: 100 })
  ).toEqual({ status: "backlog-full", remaining: Option.none() });
  expect(forwardedEmailAllowanceRemaining({ access: "free", consumed: 0 })).toEqual(
    Option.some(30)
  );
  expect(forwardedEmailAllowanceRemaining({ access: "free", consumed: 31 })).toEqual(
    Option.some(0)
  );
  expect(forwardedEmailAllowanceRemaining({ access: "pro", consumed: 31 })).toEqual(Option.none());
});

it("reduces an email to value-free structural evidence", () => {
  const candidate = redactEmailCandidate(
    "Hola Ana Pérez, compra por $45.900 COP en Restaurante El Sol, tarjeta 1234, ana@example.com"
  );
  expect(candidate).toContain("[TEXT]");
  expect(candidate).toContain("[MONEY]");
  expect(candidate).toContain("[DIGITS]");
  expect(candidate).toContain("[EMAIL]");
  expect(candidate).not.toMatch(/Ana|Pérez|Restaurante|Sol|45|1234|example/iu);
});

it.each([
  ["a multi-character word", "Hola", "[TEXT]"],
  ["a multi-character email local part", "ana@example.com", "[EMAIL]"],
  ["a numeric email local part", "1@example.com", "[EMAIL]"],
  ["a numeric email domain", "ana@123.co", "[EMAIL]"],
  ["a multi-label email domain", "ana@example.com.co", "[EMAIL]"],
  ["a multi-character email suffix", "ana@example.co", "[EMAIL]"],
  ["an alphanumeric email suffix", "ana@example.c1", "[EMAIL]"],
  ["an adjacent COP marker", "COP123", "[MONEY]"],
  ["a spaced COP marker", "COP 123", "[MONEY]"],
  ["a spaced currency symbol", "$ 123", "[MONEY]"],
  ["a multi-digit amount", "$123", "[MONEY]"],
  ["text between a COP marker and digits", "COPxyz 123", "[TEXT] [DIGITS]"],
  ["punctuation after a currency symbol", "$!123", "$![DIGITS]"],
])("preserves the redaction boundary for %s", (_case, content, expected) => {
  expect(redactEmailCandidate(content)).toBe(expected);
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

it.effect("does not create spans while interpreting statement rows", () =>
  Effect.gen(function* () {
    const tracer = Tracer.make({
      span: () => {
        throw new Error("statement interpretation created an unexpected span");
      },
    });

    yield* interpretCanonicalRows({
      rows: [csvRow(1, ["05/02/2026", "25.000", "Mercado", "DEBIT"])],
      mapping: copDebitMapping(),
      timeZone: "America/Bogota",
    }).pipe(Effect.provideService(Tracer.Tracer, tracer));
  })
);

it.effect("accounts for every row through the canonical Transaction and Money gate", () =>
  Effect.gen(function* () {
    const interpreted = yield* interpretCanonicalRows({
      rows: [
        csvRow(1, ["05/02/2026", "25.000", "Mercado", "DEBIT"]),
        csvRow(2, ["06/02/2026", "10,555", "Taxi", "DEBIT"]),
        csvRow(3, ["", "8.000", "Panadería", "DEBIT"]),
      ],
      mapping: copDebitMapping(),
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

it.effect("omits unsafe spreadsheet suggestions even when cached values look valid", () =>
  Effect.gen(function* () {
    const mapping = StatementColumnMapping.make({
      ...copDebitMapping(),
      currencyColumn: Option.some(2),
      currencyLiteral: Option.none(),
      counterpartyColumn: Option.some(3),
      directionColumn: Option.none(),
      inflowMarkers: [],
      outflowMarkers: [],
    });
    const result = yield* interpretCanonicalRows({
      rows: [
        {
          recordNumber: 1,
          fields: ["2026-02-05", "100", "USD", "Cached merchant"],
          evidence: {
            sourceFormat: "xlsx",
            sheetName: "Statement",
            sheetIndex: 0,
            rowNumber: 2,
            hidden: false,
            cells: [
              xlsxCell("A2", "2026-02-05", Option.none()),
              xlsxCell("B2", "100", Option.none()),
              xlsxCell("C2", "USD", Option.some("CURRENCY()")),
              xlsxCell("D2", "Cached merchant", Option.some("MERCHANT()")),
            ],
          },
        },
      ],
      mapping: { ...mapping, dateFormat: "yyyy-MM-dd" },
      timeZone: "America/Bogota",
    });
    const row = result.outcomes[0];
    if (row?.outcome !== "needs-review") throw new Error("Expected review outcome");
    expect(row.suggestions).toEqual(
      Option.some({
        amount: "100",
        currency: Option.none(),
        direction: Option.some("inflow"),
        counterparty: "",
        occurredAt: "2026-02-05T05:00:00.000Z",
        categoryId: Option.none(),
        userProvidedFields: [],
      })
    );
  })
);

it.effect("bounds review text and keeps missing amounts and unknown Currency unresolved", () =>
  Effect.gen(function* () {
    const mapping = StatementColumnMapping.make({
      ...copDebitMapping(),
      currencyColumn: Option.some(2),
      currencyLiteral: Option.none(),
      counterpartyColumn: Option.some(3),
      directionColumn: Option.none(),
      inflowMarkers: [],
      outflowMarkers: [],
    });
    const result = yield* interpretCanonicalRows({
      rows: [
        csvRow(1, ["invalid", "100", "???", "x".repeat(121)]),
        csvRow(2, ["invalid", "1".repeat(121), "???"]),
        csvRow(3, ["invalid"]),
      ],
      mapping,
      timeZone: "America/Bogota",
    });
    for (const [index, row] of result.outcomes.entries()) {
      if (row.outcome !== "needs-review") throw new Error("Expected review outcome");
      expect(row.suggestions).toEqual(
        Option.some({
          amount: index === 0 ? "100" : "",
          currency: Option.none(),
          direction: index === 2 ? Option.none() : Option.some("inflow"),
          counterparty: "",
          occurredAt: "",
          categoryId: Option.none(),
          userProvidedFields: [],
        })
      );
    }
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
      expect(marked.outcomes[1]).toMatchObject({
        suggestions: {
          _tag: "Some",
          value: {
            amount: "25",
            currency: Option.some(Currency.make("COP")),
            direction: Option.none(),
            counterparty: "Shop",
            occurredAt: "2026-02-05T05:00:00.000Z",
          },
        },
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

it("mechanically maps only the exact normalized four-column statement declaration", () => {
  const selected = mechanicalMappingFor([" FECHA ", "Valor", "moneda", "Contraparte"]);
  expect(Schema.encodeSync(StatementColumnMapping)(Option.getOrThrow(selected))).toEqual({
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
  for (const headers of [
    [],
    ["fecha", "valor", "moneda"],
    ["fecha", "valor", "moneda", "contraparte", "extra"],
    ["fecha", "unknown", "moneda", "contraparte"],
    ["valor", "fecha", "moneda", "contraparte"],
  ]) {
    expect(mechanicalMappingFor(headers)).toEqual(Option.none());
  }
  const row = csvRow(7, ["unmapped", "100"]);
  expect(unmappedStatementRow(row)).toEqual({
    outcome: "needs-review",
    recordNumber: 7,
    evidence: row.evidence,
    reason: "mapping-unavailable",
    knownMoney: Option.none(),
    suggestions: Option.none(),
    issues: [{ path: "", message: "Statement mapping is unavailable." }],
  });
});

it("rejects conflicting Currency sources and direction markers without a mapped direction column", () => {
  const decode = Schema.decodeUnknownResult(StatementColumnMapping);
  const value = {
    dateColumn: 0,
    amountColumn: 1,
    currencyLiteral: "COP",
    inflowMarkers: [],
    outflowMarkers: [],
    positiveDirection: "inflow",
    dateFormat: "yyyy-MM-dd",
    decimalSeparator: ".",
  };
  expect(Result.isSuccess(decode(value))).toBe(true);
  const { currencyLiteral: _, ...withoutCurrency } = value;
  expect(Result.isFailure(decode(withoutCurrency))).toBe(true);
  expect(Result.isFailure(decode({ ...value, currencyColumn: 2 }))).toBe(true);
  expect(Result.isFailure(decode({ ...value, inflowMarkers: ["CREDIT"] }))).toBe(true);
  expect(Result.isFailure(decode({ ...value, outflowMarkers: ["DEBIT"] }))).toBe(true);
  expect(
    Result.isSuccess(
      decode({ ...value, directionColumn: 3, inflowMarkers: ["CREDIT"], outflowMarkers: ["DEBIT"] })
    )
  ).toBe(true);
});

it.effect(
  "retains independently safe review suggestions when a statement row has no valid date",
  () =>
    Effect.gen(function* () {
      const result = yield* interpretCanonicalRows({
        rows: [csvRow(1, ["invalid", "100", " Mercado ", "DEBIT"])],
        mapping: copDebitMapping(),
        timeZone: "America/Bogota",
      });
      const row = result.outcomes[0];
      expect(row?.outcome).toBe("needs-review");
      if (row?.outcome !== "needs-review") throw new Error("Expected review outcome");
      expect(row.suggestions).toEqual(
        Option.some({
          amount: "100",
          currency: Option.some("COP"),
          direction: Option.some("outflow"),
          counterparty: "Mercado",
          occurredAt: "",
          categoryId: Option.none(),
          userProvidedFields: [],
        })
      );
    })
);
