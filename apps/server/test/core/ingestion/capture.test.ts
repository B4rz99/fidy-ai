import { assert, expect, it } from "@effect/vitest";
import { BigDecimal, DateTime, Option, Predicate, Result, Schema, Struct } from "effect";
import { Currency } from "~/core/_shared/money";
import {
  CaptureInterpretation,
  CaptureOccurrence,
  CaptureProposal,
} from "~/core/ingestion/contract";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { interpretCapture } from "~/core/ingestion/operations";

const context = {
  serviceMarket: ServiceMarket.make("CO"),
  locale: Locale.make("es-CO"),
  timeZone: IanaTimeZone.make("America/Bogota"),
};

const submittedAt = DateTime.makeUnsafe("2026-10-01T04:59:59.000Z");

const Proposal = CaptureProposal.pipe(Schema.toTaggedUnion("_tag")).cases;

const Occurrence = CaptureOccurrence.pipe(Schema.toTaggedUnion("_tag")).cases;

const Interpretation = CaptureInterpretation.pipe(Schema.toTaggedUnion("_tag")).cases;

type SingleMovement = typeof Proposal.SingleMovement.Type;

type NeedsReviewReason = (typeof Interpretation.NeedsReview.Type)["reason"];

const encodeOccurrence = Schema.encodeSync(CaptureOccurrence);

const singleMovement = (): SingleMovement =>
  Proposal.SingleMovement.make({
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

  assert(Predicate.isTagged(result, "Extracted"));
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
  const proposal = Proposal.SingleMovement.make(
    Schema.decodeSync(Proposal.SingleMovement.mapFields(Struct.omit(["_tag"])))({
      completion: "completed",
      money: { amount: "12.50", currency: "USD" },
      direction: "outflow",
      counterparty: "Ejemplo",
      occurrence: encodeOccurrence(
        Occurrence.LocalDate.make({ date: "2026-09-30", time: Option.none() })
      ),
    })
  );

  const result = interpretCapture({ context, proposal, submittedAt, now: submittedAt });
  assert(Predicate.isTagged(result, "Extracted"));
  expect(result.extraction.money.currency).toBe(Currency.make("USD"));
  expect(BigDecimal.format(result.extraction.money.amount)).toBe("12.5");
  expect(DateTime.formatIso(result.extraction.occurredAt)).toBe("2026-09-30T05:00:00.000Z");
  expect(result.evidence.currencyBasis).toBe("explicit");
  expect(result.evidence.dateBasis).toBe("explicit");
});

it("uses explicit local time and historical time zone rather than the Bogotá allowance zone", () => {
  const proposal = {
    ...singleMovement(),
    occurrence: Option.some(
      Occurrence.LocalDate.make({
        date: "2026-09-30",
        time: Option.some("12:34:56"),
      })
    ),
  };

  const result = interpretCapture({
    context: { ...context, timeZone: IanaTimeZone.make("America/New_York") },
    proposal,
    submittedAt,
    now: submittedAt,
  });

  assert(Predicate.isTagged(result, "Extracted"));
  expect(DateTime.formatIso(result.extraction.occurredAt)).toBe("2026-09-30T16:34:56.000Z");
});

it("reviews multiple, unparseable and unfinished movements instead of selecting or completing one", () => {
  const cases: ReadonlyArray<Readonly<{ proposal: CaptureProposal; reason: NeedsReviewReason }>> = [
    { proposal: Proposal.MultipleMovements.make({}), reason: "multiple-movements" },
    { proposal: Proposal.Unparseable.make({}), reason: "unparseable-material" },
    ...(["pending", "rejected", "cancelled", "unclear"] as const).map((completion) => ({
      proposal: { ...singleMovement(), completion },
      reason: "movement-not-completed" as const,
    })),
  ];

  for (const { proposal, reason } of cases) {
    expect(interpretCapture({ context, proposal, submittedAt, now: submittedAt })).toEqual(
      Interpretation.NeedsReview.make({ reason })
    );
  }
});

it("reviews missing financial facts and Money invalid for its Currency without fabricating replacements", () => {
  const cases: ReadonlyArray<Readonly<{ proposal: CaptureProposal; reason: NeedsReviewReason }>> = [
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
      reason: "canonical-validation-failed" as const,
    })),
  ];

  for (const { proposal, reason } of cases) {
    expect(interpretCapture({ context, proposal, submittedAt, now: submittedAt })).toEqual(
      Interpretation.NeedsReview.make({ reason })
    );
  }
});

it("does not replace invalid source dates or future instants with the submission-date default", () => {
  const invalid: ReadonlyArray<SingleMovement["occurrence"]> = [
    Option.some(Occurrence.LocalDate.make({ date: "2026-02-30", time: Option.none() })),
    Option.some(Occurrence.LocalDate.make({ date: "0000-01-01", time: Option.none() })),
    Option.some(
      Occurrence.Instant.make({ value: DateTime.makeUnsafe("2026-10-02T12:00:00.000Z") })
    ),
  ];

  for (const occurrence of invalid) {
    expect(
      interpretCapture({
        context,
        proposal: { ...singleMovement(), occurrence },
        submittedAt,
        now: submittedAt,
      })
    ).toEqual(Interpretation.NeedsReview.make({ reason: "invalid-occurrence" }));
  }

  const explicit = interpretCapture({
    context,
    proposal: {
      ...singleMovement(),
      occurrence: Option.some(Occurrence.Instant.make({ value: submittedAt })),
    },
    submittedAt,
    now: submittedAt,
  });

  assert(Predicate.isTagged(explicit, "Extracted"));
  expect(explicit.evidence.dateBasis).toBe("explicit");
  expect(DateTime.formatIso(explicit.extraction.occurredAt)).toBe("2026-10-01T04:59:59.000Z");
});

it("reviews ambiguous and nonexistent local times instead of guessing a daylight-saving occurrence", () => {
  for (const date of ["2026-03-08", "2026-11-01"]) {
    const proposal = {
      ...singleMovement(),
      occurrence: Option.some(
        Occurrence.LocalDate.make({
          date,
          time: Option.some(date === "2026-03-08" ? "02:30:00" : "01:30:00"),
        })
      ),
    };

    expect(
      interpretCapture({
        context: { ...context, timeZone: IanaTimeZone.make("America/New_York") },
        proposal,
        submittedAt,
        now: DateTime.makeUnsafe("2026-12-01T12:00:00Z"),
      })
    ).toEqual(Interpretation.NeedsReview.make({ reason: "invalid-occurrence" }));
  }
});

const localDate = encodeOccurrence(
  Occurrence.LocalDate.make({ date: "2026-01-01", time: Option.none() })
);

it("rejects malformed explicitly supplied Currency and date shapes at the proposal decoder", () => {
  const valid = Schema.encodeSync(CaptureProposal)(singleMovement());

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
        occurrence: { ...localDate, date: "30/09/2026" },
      })
    )
  ).toBe(true);
});

it("bounds explicit local occurrence spellings before calendar interpretation", () => {
  const decode = Schema.decodeUnknownResult(CaptureOccurrence);

  for (const date of ["2026-01-01", "2026-09-10", "2026-10-20", "2026-11-30", "2026-12-31"]) {
    expect(Result.isSuccess(decode({ ...localDate, date }))).toBe(true);
  }

  for (const date of [
    "x2026-01-01",
    "2026-01-01x",
    "2026-00-01",
    "2026-13-01",
    "2026-01-00",
    "2026-01-32",
  ]) {
    expect(Result.isFailure(decode({ ...localDate, date }))).toBe(true);
  }

  for (const time of ["00:00:00", "19:59:59", "20:00:00", "23:59:59"]) {
    expect(Result.isSuccess(decode({ ...localDate, time }))).toBe(true);
  }

  for (const time of [
    "x00:00:00",
    "00:00:00x",
    "24:00:00",
    "00:60:00",
    "00:00:60",
    "0:00:00",
    "00:0:00",
    "00:00:0",
  ]) {
    expect(Result.isFailure(decode({ ...localDate, time }))).toBe(true);
  }
});

it("accepts an explicit source date in the first supported Gregorian year", () => {
  const result = interpretCapture({
    context: { ...context, timeZone: IanaTimeZone.make("Etc/UTC") },
    proposal: {
      ...singleMovement(),
      occurrence: Option.some(
        Occurrence.LocalDate.make({ date: "0001-01-01", time: Option.none() })
      ),
    },
    submittedAt,
    now: submittedAt,
  });

  expect(Predicate.isTagged(result, "Extracted")).toBe(true);
});

it("reports invalid Money before an independently invalid occurrence", () => {
  const proposal = {
    ...singleMovement(),
    money: Option.some({
      amount: BigDecimal.make(-1n, 0),
      currency: Option.some(Currency.make("COP")),
    }),
    occurrence: Option.some(
      Occurrence.Instant.make({
        value: DateTime.makeUnsafe("2027-01-01T00:00:00Z"),
      })
    ),
  };

  expect(interpretCapture({ context, proposal, submittedAt, now: submittedAt })).toEqual(
    Interpretation.NeedsReview.make({ reason: "canonical-validation-failed" })
  );
});

it("rejects year zero as an invalid occurrence even for the GMT named-zone alias", () => {
  const result = interpretCapture({
    context: { ...context, timeZone: IanaTimeZone.make("GMT") },
    proposal: {
      ...singleMovement(),
      occurrence: Option.some(
        Occurrence.LocalDate.make({ date: "0000-01-01", time: Option.none() })
      ),
    },
    submittedAt,
    now: submittedAt,
  });

  expect(result).toEqual(Interpretation.NeedsReview.make({ reason: "invalid-occurrence" }));
});
