import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import {
  BrowserLoginPublicCodeInput,
  browserLoginPublicCodeAlphabet,
  decideApprovalTransition,
  selectPublicCodeSymbols,
} from "./rules";

const decode = Schema.decodeUnknownOption(BrowserLoginPublicCodeInput);

it("normalizes lowercase, surrounding ASCII whitespace, and an omitted display hyphen", () => {
  expect(Option.getOrThrow(decode("bcdfghjk"))).toBe("BCDF-GHJK");
  expect(Option.getOrThrow(decode("bcdf-ghjk"))).toBe("BCDF-GHJK");
  expect(Option.getOrThrow(decode(" \tBCDF-GHJK\r\n"))).toBe("BCDF-GHJK");
  expect(Option.isNone(decode("\u00a0BCDF-GHJK"))).toBe(true);
  expect(Option.isNone(decode("B-CDFGHJK"))).toBe(true);
  expect(Option.isNone(decode("BCDF‐GHJK"))).toBe(true);
});

it("keeps the public code alphabet at twenty unambiguous symbols", () => {
  expect(browserLoginPublicCodeAlphabet).toHaveLength(20);
  expect(new Set(browserLoginPublicCodeAlphabet).size).toBe(20);
});

it("maps equal byte ranges to every symbol and rejects the biased tail", () => {
  const oneOfEach = Array.from({ length: 20 }, (_, index) => index);
  expect(selectPublicCodeSymbols({ bytes: oneOfEach, maximum: 20 })).toBe(
    browserLoginPublicCodeAlphabet
  );
  expect(
    selectPublicCodeSymbols({
      bytes: [239, 240, 255, 0],
      maximum: 3,
    })
  ).toBe("ZB");
});

it.effect("binds only when no newer or equal Ready challenge exists", () =>
  Effect.gen(function* () {
    expect(
      yield* decideApprovalTransition({ candidateOrdinal: 2n, readyOrdinal: Option.none() })
    ).toBe("bind");
    expect(
      yield* decideApprovalTransition({ candidateOrdinal: 2n, readyOrdinal: Option.some(1n) })
    ).toBe("bind");
    expect(
      yield* decideApprovalTransition({ candidateOrdinal: 2n, readyOrdinal: Option.some(2n) })
    ).toBe("reject");
  })
);
