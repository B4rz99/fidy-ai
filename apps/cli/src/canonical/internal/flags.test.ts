import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { assembleFlags, deriveFlags } from "./flags";

it("disambiguates siblings, transport containers and reserved options without accepting short aliases", () => {
  const schema = Schema.Struct({
    payload: Schema.Struct({
      left: Schema.Struct({ categoryId: Schema.String }),
      right: Schema.Struct({ categoryId: Schema.String }),
      input: Schema.Boolean,
      json: Schema.Boolean,
      id: Schema.Boolean,
    }),
    query: Schema.Struct({ id: Schema.Boolean }),
  });
  // Booleans are sufficient to exercise names independently of string classification.
  const plan = deriveFlags(Schema.toJsonSchemaDocument(schema));
  expect(plan.flags.map((flag) => flag.name)).toEqual([
    "payload-input",
    "payload-json",
    "payload-id",
    "query-id",
  ]);
  const nested = deriveFlags(
    Schema.toJsonSchemaDocument(
      Schema.Struct({
        payload: Schema.Struct({
          left: Schema.Struct({ categoryId: Schema.Boolean }),
          right: Schema.Struct({ categoryId: Schema.Boolean }),
        }),
      })
    )
  );
  expect(nested.flags.map((flag) => flag.name)).toEqual(["left-category-id", "right-category-id"]);
  expect(
    assembleFlags({
      args: ["--left-category-id", "true", "--right-category-id", "false"],
      plan: nested,
    })
  ).toEqual({ payload: { left: { categoryId: true }, right: { categoryId: false } } });
  expect(() => assembleFlags({ args: ["--category-id", "true"], plan: nested })).toThrow();
});

it("preserves omitted defaults, explicit false, zero and empty text for the owning whole decoder", () => {
  const schema = Schema.Struct({
    payload: Schema.Struct({
      enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
      count: Schema.optionalKey(Schema.Int),
      text: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-z]*$/u))),
      mode: Schema.Literals(["one", "two"]),
    }),
  });
  const plan = deriveFlags(Schema.toJsonSchemaDocument(schema));
  expect(plan.flags.map(({ name, required }) => ({ name, required }))).toEqual([
    { name: "enabled", required: false },
    { name: "count", required: false },
    { name: "text", required: false },
    { name: "mode", required: true },
  ]);
  const decode = Schema.decodeUnknownSync(schema);
  expect(decode(assembleFlags({ args: ["--mode", "one"], plan }))).toEqual({
    payload: { enabled: true, mode: "one" },
  });
  expect(
    decode(
      assembleFlags({
        args: ["--mode", "two", "--enabled", "false", "--count", "0", "--text", ""],
        plan,
      })
    )
  ).toEqual({ payload: { enabled: false, count: 0, text: "", mode: "two" } });
});

it("a schema extension generates new help and assembly without a parallel field registry", () => {
  const schema = Schema.Struct({
    query: Schema.Struct({
      pageSize: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
    }),
  });
  const plan = deriveFlags(Schema.toJsonSchemaDocument(schema));
  expect(plan.flags).toMatchObject([
    { name: "page-size", required: false, constraints: { minimum: 1, maximum: 20 } },
  ]);
  expect(
    Schema.decodeUnknownSync(schema)(assembleFlags({ args: ["--page-size", "12"], plan }))
  ).toEqual({ query: { pageSize: 12 } });
});

it("keeps complex unions, arrays, unconstrained and free-text strings on structured input", () => {
  const schema = Schema.Struct({
    payload: Schema.Struct({
      calls: Schema.Array(Schema.Boolean),
      prose: Schema.Trimmed,
      variant: Schema.Union([
        Schema.Struct({ a: Schema.Boolean }),
        Schema.Struct({ b: Schema.Boolean }),
      ]),
    }),
  });
  const plan = deriveFlags(Schema.toJsonSchemaDocument(schema));
  expect(plan.flags).toEqual([]);
  expect(plan.structured.map((field) => field.path)).toEqual([
    ["payload", "calls"],
    ["payload", "prose"],
    ["payload", "variant"],
  ]);
  expect(() => assembleFlags({ args: [], plan })).toThrow();
});
