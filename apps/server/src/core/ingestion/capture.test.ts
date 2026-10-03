import { expect, it } from "@effect/vitest";
import { BigDecimal, DateTime, Option, Schema } from "effect";
import { Currency } from "~/core/_shared/money";
import { CaptureProposal } from "./contract";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { interpretCapture } from "./operations";

const context = {
  serviceMarket: ServiceMarket.make("CO"),
  locale: Locale.make("es-CO"),
  timeZone: IanaTimeZone.make("America/Bogota"),
};
const submittedAt = DateTime.makeUnsafe("2026-10-01T04:59:59.000Z");
type SingleMovement = Extract<CaptureProposal, { readonly _tag: "SingleMovement" }>;
const singleMovement = (): SingleMovement => ({
  _tag: "SingleMovement",
  completion: "completed",
  money: Option.some({ amount: BigDecimal.fromStringUnsafe("35000"), currency: Option.none() }),
  direction: Option.some("outflow"),
  counterparty: Option.none(),
  occurrence: Option.none(),
});

it("defaults missing Currency and date without substituting processing time", () => {
  const result = interpretCapture({
    context,
    submittedAt,
    now: DateTime.makeUnsafe("2026-10-02T12:00:00.000Z"),
    proposal: singleMovement(),
  });
  expect(result._tag).toBe("Extracted");
  if (result._tag !== "Extracted") return;
  expect(result.extraction.money.currency).toBe("COP");
  expect(BigDecimal.format(result.extraction.money.amount)).toBe("35000");
  expect(DateTime.formatIso(result.extraction.occurredAt)).toBe("2026-10-01T04:59:59.000Z");
  expect(result.evidence).toMatchObject({
    currencyBasis: "default",
    dateBasis: "submission-date-default",
    revision: "capture-v1",
  });
});

it("preserves explicit foreign Currency and interprets a source date in its captured time zone", () => {
  const proposal = Schema.decodeSync(CaptureProposal)({
    _tag: "SingleMovement",
    completion: "completed",
    money: { amount: "12.50", currency: "USD" },
    direction: "outflow",
    counterparty: "Ejemplo",
    occurrence: { _tag: "LocalDate", date: "2026-09-30" },
  });
  const result = interpretCapture({ context, proposal, submittedAt, now: submittedAt });
  expect(result._tag).toBe("Extracted");
  if (result._tag !== "Extracted") return;
  expect(result.extraction.money.currency).toBe(Currency.make("USD"));
  expect(BigDecimal.format(result.extraction.money.amount)).toBe("12.5");
  expect(DateTime.formatIso(result.extraction.occurredAt)).toBe("2026-09-30T05:00:00.000Z");
  expect(result.evidence.currencyBasis).toBe("explicit");
  expect(result.evidence.dateBasis).toBe("explicit");
});

it("uses explicit local time and historical time zone rather than the Bogotá allowance zone", () => {
  const proposal = {
    ...singleMovement(),
    occurrence: Option.some({
      _tag: "LocalDate" as const,
      date: "2026-09-30",
      time: Option.some("12:34:56"),
    }),
  };
  const result = interpretCapture({
    context: { ...context, timeZone: IanaTimeZone.make("America/New_York") },
    proposal,
    submittedAt,
    now: submittedAt,
  });
  expect(result._tag).toBe("Extracted");
  if (result._tag !== "Extracted") return;
  expect(DateTime.formatIso(result.extraction.occurredAt)).toBe("2026-09-30T16:34:56.000Z");
});

it("reviews multiple, unparseable and unfinished movements instead of selecting or completing one", () => {
  const cases: ReadonlyArray<Readonly<{ proposal: CaptureProposal; reason: string }>> = [
    { proposal: { _tag: "MultipleMovements" }, reason: "multiple-movements" },
    { proposal: { _tag: "Unparseable" }, reason: "unparseable-material" },
    ...(["pending", "rejected", "cancelled", "unclear"] as const).map((completion) => ({
      proposal: { ...singleMovement(), completion },
      reason: "movement-not-completed",
    })),
  ];
  for (const { proposal, reason } of cases) {
    expect(interpretCapture({ context, proposal, submittedAt, now: submittedAt })).toEqual({
      _tag: "NeedsReview",
      reason,
    });
  }
});

it("reviews missing financial facts and Money invalid for its Currency without fabricating replacements", () => {
  const cases = [
    { proposal: { ...singleMovement(), money: Option.none() }, reason: "missing-required-fact" },
    {
      proposal: { ...singleMovement(), direction: Option.none() },
      reason: "missing-required-fact",
    },
    ...["0", "-1", "12.345"].map((amount) => ({
      proposal: {
        ...singleMovement(),
        money: Option.some({
          amount: BigDecimal.fromStringUnsafe(amount),
          currency: Option.some(Currency.make("USD")),
        }),
      },
      reason: "canonical-validation-failed",
    })),
  ];
  for (const { proposal, reason } of cases) {
    expect(interpretCapture({ context, proposal, submittedAt, now: submittedAt })).toEqual({
      _tag: "NeedsReview",
      reason,
    });
  }
});

it("does not replace invalid source dates or future instants with the submission-date default", () => {
  const invalid: ReadonlyArray<SingleMovement["occurrence"]> = [
    Option.some({ _tag: "LocalDate", date: "2026-02-30", time: Option.none() }),
    Option.some({ _tag: "LocalDate", date: "0000-01-01", time: Option.none() }),
    Option.some({ _tag: "Instant", value: DateTime.makeUnsafe("2026-10-02T12:00:00.000Z") }),
  ];
  for (const occurrence of invalid) {
    expect(
      interpretCapture({
        context,
        proposal: { ...singleMovement(), occurrence },
        submittedAt,
        now: submittedAt,
      })
    ).toEqual({ _tag: "NeedsReview", reason: "invalid-occurrence" });
  }
  const explicit = interpretCapture({
    context,
    proposal: {
      ...singleMovement(),
      occurrence: Option.some({ _tag: "Instant", value: submittedAt }),
    },
    submittedAt,
    now: submittedAt,
  });
  expect(explicit._tag).toBe("Extracted");
  if (explicit._tag !== "Extracted") return;
  expect(explicit.evidence.dateBasis).toBe("explicit");
  expect(DateTime.formatIso(explicit.extraction.occurredAt)).toBe("2026-10-01T04:59:59.000Z");
});

it("reviews ambiguous and nonexistent local times instead of guessing a daylight-saving occurrence", () => {
  for (const date of ["2026-03-08", "2026-11-01"]) {
    const proposal = {
      ...singleMovement(),
      occurrence: Option.some({
        _tag: "LocalDate" as const,
        date,
        time: Option.some(date === "2026-03-08" ? "02:30:00" : "01:30:00"),
      }),
    };
    expect(
      interpretCapture({
        context: { ...context, timeZone: IanaTimeZone.make("America/New_York") },
        proposal,
        submittedAt,
        now: DateTime.makeUnsafe("2026-12-01T12:00:00Z"),
      })
    ).toEqual({ _tag: "NeedsReview", reason: "invalid-occurrence" });
  }
});

it("rejects malformed explicitly supplied Currency and date shapes at the proposal decoder", () => {
  const valid = {
    _tag: "SingleMovement",
    completion: "completed",
    direction: "outflow",
    money: { amount: "35000" },
  };
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(CaptureProposal)({
        ...valid,
        money: { amount: "35000", currency: "???" },
      })
    )
  ).toBe(true);
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(CaptureProposal)({
        ...valid,
        occurrence: { _tag: "LocalDate", date: "30/09/2026" },
      })
    )
  ).toBe(true);
});
