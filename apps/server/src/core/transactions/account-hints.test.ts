import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import {
  AccountHints,
  InstrumentLabel,
  LastFourDigits,
  compareAccountHints,
} from "./account-hints";

describe("safe account hints", () => {
  it.effect("lets a same-kind suffix conflict override agreeing card and label evidence", () =>
    Effect.gen(function* () {
      const left = yield* Schema.decodeEffect(AccountHints)({
        cardLastFour: "0012",
        accountLastFour: "0034",
        instrumentLabel: "visa oro",
      });
      const right = yield* Schema.decodeEffect(AccountHints)({
        cardLastFour: "0012",
        accountLastFour: "0099",
        instrumentLabel: "visa oro",
      });
      expect(yield* compareAccountHints(left, right)).toBe("conflict");
    })
  );

  it.effect("treats exact same-slot evidence as equal without comparing namespaces", () =>
    Effect.gen(function* () {
      const card = yield* Schema.decodeEffect(AccountHints)({ cardLastFour: "0012" });
      const cardAndAccount = yield* Schema.decodeEffect(AccountHints)({
        cardLastFour: "0012",
        accountLastFour: "0012",
      });
      expect(yield* compareAccountHints(card, cardAndAccount)).toBe("equal");
      const label = yield* Schema.decodeEffect(AccountHints)({ instrumentLabel: "Visa Oro" });
      const normalizedLabel = yield* Schema.decodeEffect(AccountHints)({
        instrumentLabel: "VISA\u00a0 ORO",
      });
      expect(yield* compareAccountHints(label, normalizedLabel)).toBe("equal");
    })
  );

  it.effect("leaves absent, cross-kind, and differing-label evidence unknown", () =>
    Effect.gen(function* () {
      const absent = yield* Schema.decodeEffect(AccountHints)({});
      const card = yield* Schema.decodeEffect(AccountHints)({ cardLastFour: "0012" });
      const account = yield* Schema.decodeEffect(AccountHints)({ accountLastFour: "0012" });
      const longLabel = yield* Schema.decodeEffect(AccountHints)({ instrumentLabel: "visa oro" });
      const shortLabel = yield* Schema.decodeEffect(AccountHints)({ instrumentLabel: "visa" });
      for (const [left, right] of [
        [absent, absent],
        [card, account],
        [longLabel, shortLabel],
      ] as const) {
        expect(yield* compareAccountHints(left, right)).toBe("unknown");
      }
    })
  );

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
