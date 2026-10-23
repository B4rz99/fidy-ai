import { AllowanceKind, AllowanceMeter, CanonicalRetryKey } from "./contract";
import { Result, Schema } from "effect";
import { expect, it } from "vitest";

it("accepts bounded opaque retry references without whitespace or interpreter punctuation", () => {
  const decode = Schema.decodeUnknownResult(CanonicalRetryKey);
  for (const value of ["a", "Z", "0", "_", "-", "retry_ABC-019", "a".repeat(128)]) {
    expect(Result.isSuccess(decode(value)), value).toBe(true);
  }
  for (const value of [
    "",
    "a".repeat(129),
    "a b",
    "a\nb",
    " a",
    "a ",
    "a/b",
    "a.b",
    "a+b",
    "á",
    "a:b",
    "a@b",
    "[key]",
    "a\u0000",
  ]) {
    expect(Result.isFailure(decode(value)), value).toBe(true);
  }
});

it("decodes each independent commercial meter and both entitlement states", () => {
  for (const kind of [
    "forwarded_email",
    "media_submission",
    "hosted_history_turn",
    "canonical_call",
  ]) {
    expect(Schema.decodeUnknownSync(AllowanceKind)(kind)).toBe(kind);
  }
  const limited = {
    _tag: "Limited",
    limit: 30,
    consumed: 2,
    remaining: 28,
    period: { startsAt: "2026-10-01T05:00:00.000Z", resetsAt: "2026-11-01T05:00:00.000Z" },
  };
  const codec = Schema.toCodecJson(AllowanceMeter);
  for (const value of [limited, { _tag: "Uncapped" }]) {
    expect(Schema.encodeSync(codec)(Schema.decodeSync(codec)(value))).toEqual(value);
  }
});
