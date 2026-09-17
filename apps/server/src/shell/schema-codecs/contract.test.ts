import { BigDecimal, DateTime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { UnknownJsonString, jsonStringSchema } from "./contract";

describe("Schema Codecs contract", () => {
  it("preserves arbitrary JSON-string encoding behavior", () => {
    const encoded = Schema.encodeUnknownSync(UnknownJsonString)({
      occurredAt: DateTime.makeUnsafe("2026-08-01T12:00:00Z"),
    });

    expect(encoded).toBe('{"occurredAt":"2026-08-01T12:00:00.000Z"}');
  });

  it("derives JSON-string boundaries from the schema JSON codec", () => {
    const Boundary = jsonStringSchema(
      Schema.Struct({ money: Schema.Struct({ amount: Schema.BigDecimal }) })
    );
    const decoded = Schema.decodeSync(Boundary)('{"money":{"amount":"25000.50"}}');

    expect(BigDecimal.equals(decoded.money.amount, BigDecimal.fromStringUnsafe("25000.50"))).toBe(
      true
    );
    expect(Schema.encodeUnknownSync(Boundary)(decoded)).toBe('{"money":{"amount":"25000.5"}}');
  });
});
