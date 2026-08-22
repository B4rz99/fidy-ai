import { expect, it } from "@effect/vitest";
import { DateTime, Option, Schema } from "effect";
import {
  BrowserLoginPublicCodeInput,
  browserLoginPublicCodeAlphabet,
  decideApprovalTransition,
  decideBrowserLoginRedemption,
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

it("binds only when no newer or equal Ready challenge exists", () => {
  expect(decideApprovalTransition({ candidateOrdinal: 2n, readyOrdinal: Option.none() })).toBe(
    "bind"
  );
  expect(decideApprovalTransition({ candidateOrdinal: 2n, readyOrdinal: Option.some(1n) })).toBe(
    "bind"
  );
  expect(decideApprovalTransition({ candidateOrdinal: 2n, readyOrdinal: Option.some(2n) })).toBe(
    "reject"
  );
});

it("owns the wrong-verifier attempt and lifecycle transition", () => {
  const base = {
    lifecycle: "ready",
    verifierMatches: false,
    minimumPollIntervalSeconds: 5,
    lastAcceptedPollAt: Option.none(),
    expiresAt: DateTime.makeUnsafe("2026-03-01T12:10:00.000Z"),
    attemptedAt: DateTime.makeUnsafe("2026-03-01T12:00:05.000Z"),
  } as const;

  expect(decideBrowserLoginRedemption({ ...base, wrongVerifierAttempts: 3 })).toEqual({
    _tag: "WrongVerifier",
    wrongVerifierAttempts: 4,
    lifecycle: "ready",
  });
  expect(decideBrowserLoginRedemption({ ...base, wrongVerifierAttempts: 4 })).toEqual({
    _tag: "WrongVerifier",
    wrongVerifierAttempts: 5,
    lifecycle: "invalidated",
  });
});

it("expires an active pairing before evaluating its verifier", () => {
  const expiresAt = DateTime.makeUnsafe("2026-03-01T12:10:00.000Z");

  expect(
    decideBrowserLoginRedemption({
      lifecycle: "ready",
      verifierMatches: false,
      wrongVerifierAttempts: 4,
      minimumPollIntervalSeconds: 5,
      lastAcceptedPollAt: Option.none(),
      expiresAt,
      attemptedAt: expiresAt,
    })
  ).toEqual({ _tag: "Expired" });
});

it("accepts the first correct pending poll and slows every repeated too-fast poll by five seconds", () => {
  const expiresAt = DateTime.makeUnsafe("2026-03-01T12:10:00.000Z");
  const firstPollAt = DateTime.makeUnsafe("2026-03-01T12:00:05.000Z");

  expect(
    decideBrowserLoginRedemption({
      lifecycle: "pending_approval",
      verifierMatches: true,
      wrongVerifierAttempts: 0,
      minimumPollIntervalSeconds: 5,
      lastAcceptedPollAt: Option.none(),
      expiresAt,
      attemptedAt: firstPollAt,
    })
  ).toEqual({ _tag: "Pending", acceptedAt: firstPollAt, minimumPollIntervalSeconds: 5 });

  expect(
    decideBrowserLoginRedemption({
      lifecycle: "pending_approval",
      verifierMatches: true,
      wrongVerifierAttempts: 0,
      minimumPollIntervalSeconds: 5,
      lastAcceptedPollAt: Option.some(firstPollAt),
      expiresAt,
      attemptedAt: DateTime.addDuration(firstPollAt, "2 seconds"),
    })
  ).toEqual({ _tag: "SlowDown", minimumPollIntervalSeconds: 10, retryAfterSeconds: 8 });
});
