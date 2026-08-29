import { BigDecimal, DateTime, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  SchemaSerializableError,
  TaggedSerializableError,
  UnknownJsonString,
  jsonStringSchema,
} from "~/schema-compatibility";

class ExampleFailure extends SchemaSerializableError<ExampleFailure>("ExampleFailure")(
  {
    _tag: Schema.tagDefaultOmit("ExampleFailure"),
    error: Schema.Struct({ code: Schema.Literal("example_failure") }),
  },
  { httpApiStatus: 409 }
) {}

class ExampleTaggedFailure extends TaggedSerializableError<ExampleTaggedFailure>()(
  "ExampleTaggedFailure",
  { reason: Schema.Literal("refused") }
) {}

describe("schema compatibility", () => {
  it("preserves schema-serializable failures across construction, encoding, and decoding", () => {
    const failure = ExampleFailure.make({ error: { code: "example_failure" } });
    const encoded = Schema.encodeUnknownSync(ExampleFailure)(failure);
    const decoded = Schema.decodeUnknownSync(ExampleFailure)(encoded);

    expect(encoded).toEqual({ error: { code: "example_failure" } });
    expect(decoded).toBeInstanceOf(ExampleFailure);
    expect(decoded._tag).toBe("ExampleFailure");
  });

  it("preserves tagged schema-serializable failures as yieldable typed failures", () => {
    const failure = ExampleTaggedFailure.make({ reason: "refused" });
    const recovered = Effect.runSync(
      Effect.fail(failure).pipe(
        Effect.catchTag("ExampleTaggedFailure", ({ reason }) => Effect.succeed(reason))
      )
    );

    expect(recovered).toBe("refused");
  });

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
    const decoded = Schema.decodeUnknownSync(Boundary)('{"money":{"amount":"25000.50"}}');

    expect(BigDecimal.equals(decoded.money.amount, BigDecimal.fromStringUnsafe("25000.50"))).toBe(
      true
    );
    expect(Schema.encodeUnknownSync(Boundary)(decoded)).toBe('{"money":{"amount":"25000.5"}}');
  });
});
