import { AllowanceMeter, CanonicalRetryKey } from "~/core/quotas/contract";
import { DateTime, Result, Schema } from "effect";
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

it("preserves limited and uncapped entitlement states on the wire", () => {
  const Meter = AllowanceMeter.pipe(Schema.toTaggedUnion("_tag")).cases;

  const limited = Meter.Limited.make({
    limit: 30,
    consumed: 2,
    remaining: 28,
    period: {
      startsAt: DateTime.makeUnsafe("2026-10-01T05:00:00.000Z"),
      resetsAt: DateTime.makeUnsafe("2026-11-01T05:00:00.000Z"),
    },
  });

  const codec = Schema.toCodecJson(AllowanceMeter);

  expect(Schema.encodeSync(codec)(limited)).toMatchObject({
    limit: 30,
    consumed: 2,
    remaining: 28,
    period: { startsAt: "2026-10-01T05:00:00.000Z", resetsAt: "2026-11-01T05:00:00.000Z" },
  });

  for (const value of [limited, Meter.Uncapped.make({})]) {
    const encoded = Schema.encodeSync(codec)(value);

    expect(Schema.decodeSync(codec)(encoded)).toEqual(value);
    expect(Schema.encodeSync(codec)(Schema.decodeSync(codec)(encoded))).toEqual(encoded);
  }
});
