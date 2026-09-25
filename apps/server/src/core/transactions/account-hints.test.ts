import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { AccountHints, InstrumentLabel, LastFourDigits } from "./account-hints";

describe("safe account hints", () => {
  it("rejects identifiers other than exactly four ASCII digits", () => {
    for (const value of [
      "",
      "123",
      "12345",
      "*0012",
      " 0012",
      "0012\n",
      "１２３４",
      "4111111111111111",
    ]) {
      expect(Schema.decodeOption(LastFourDigits)(value)).toEqual(Option.none());
    }
  });

  it("rejects empty, control-bearing, and oversized normalized labels", () => {
    for (const value of ["", " \u00a0 ", "visa\u0000oro", "visa\u200boro", "a".repeat(65)]) {
      expect(Schema.decodeOption(InstrumentLabel)(value)).toEqual(Option.none());
    }
    expect(Schema.decodeOption(InstrumentLabel)("💳".repeat(64))).toEqual(
      Option.some("💳".repeat(64))
    );
  });

  it.effect("preserves leading zeros and normalizes only explicit product labels", () =>
    Effect.gen(function* () {
      const hints = yield* Schema.decodeEffect(AccountHints)({
        cardLastFour: "0012",
        instrumentLabel: "  ＶＩＳＡ\u00a0  Oro  ",
      });
      expect(hints.cardLastFour).toEqual(Option.some("0012"));
      expect(hints.accountLastFour).toEqual(Option.none());
      expect(hints.instrumentLabel).toEqual(Option.some("visa oro"));
    })
  );
});
