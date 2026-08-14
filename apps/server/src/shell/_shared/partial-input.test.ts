import { expect, it } from "@effect/vitest";
import { type Option, Result, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { expectTypeOf } from "vitest";
import { type PartialInput, makePartialInputSchema } from "./partial-input";

type CatalogTree = {
  readonly name: string;
  readonly children: ReadonlyArray<CatalogTree>;
};

const CatalogTree: Schema.Codec<CatalogTree> = Schema.suspend(() =>
  Schema.Struct({
    name: Schema.String,
    children: Schema.Array(CatalogTree),
  })
).annotate({ identifier: "CatalogTree" });

it("partials identified object members inside arrays, unions, records, and suspensions", () => {
  const item = Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("detailed"),
      detail: Schema.Struct({ left: Schema.String, right: Schema.String }),
    }),
    Schema.Struct({ kind: Schema.Literal("simple"), value: Schema.String }),
  ]).annotate({ identifier: "CatalogItem" });
  const input = Schema.Struct({
    items: Schema.Array(item).annotate({ identifier: "CatalogItems" }),
    lookup: Schema.Record(
      Schema.String,
      Schema.Struct({ left: Schema.String, right: Schema.String })
    ),
    tree: CatalogTree,
  });
  const partial = makePartialInputSchema(input);
  const result = Schema.encodeUnknownResult(partial)({
    items: [{ kind: "detailed", detail: { left: "known" } }],
    lookup: { first: { left: "known" } },
    tree: { name: "root" },
  });

  expect(Result.isSuccess(result)).toBe(true);

  const surfaceApi = HttpApi.make("partial-surface-test").add(
    HttpApiGroup.make("surface").add(
      HttpApiEndpoint.get("getPartial", "/partial", { success: partial })
    )
  );
  const published = JSON.stringify(OpenApi.fromApi(surfaceApi));
  expect(published).toContain("CatalogItemsPartial");
  expect(published).toContain("CatalogItemPartial");
  expect(published).toContain("CatalogTreePartial");
});

it("checks only record values whose keys match each index signature", () => {
  const checkedInput = Schema.StructWithRest(Schema.Struct({}), [
    Schema.Record(Schema.String, Schema.Struct({ left: Schema.String })),
    Schema.Record(
      Schema.Symbol,
      Schema.Struct({ right: Schema.String, additional: Schema.String })
    ),
  ]).check(Schema.makeFilter(() => ({ path: [], issue: "Expected allowed" })));
  const partial = makePartialInputSchema(checkedInput);
  const result = Schema.encodeUnknownResult(partial)({ entry: { left: "known" } });

  expect(Result.isFailure(result)).toBe(true);
});

it("matches template, numeric, symbol, and union record keys before checking values", () => {
  const value = Schema.Struct({ left: Schema.String, right: Schema.String });
  const checkedRecord = (key: Schema.Record.Key): Schema.Codec<unknown, unknown> =>
    makePartialInputSchema(
      Schema.StructWithRest(Schema.Struct({}), [Schema.Record(key, value)]).check(
        Schema.makeFilter(() => ({ path: [], issue: "Expected allowed" }))
      )
    );
  const template = checkedRecord(Schema.TemplateLiteral(["item-", Schema.String]));
  const number = checkedRecord(Schema.Finite);
  const symbolOrNumber = checkedRecord(Schema.Union([Schema.Symbol, Schema.Finite]));
  const symbolKey = Symbol.for("entry");

  expect(
    Result.isSuccess(Schema.encodeUnknownResult(template)({ "item-a": { left: "known" } }))
  ).toBe(true);
  expect(Result.isFailure(Schema.encodeUnknownResult(template)({ other: { left: "known" } }))).toBe(
    true
  );
  expect(Result.isSuccess(Schema.encodeUnknownResult(number)({ 1: { left: "known" } }))).toBe(true);
  expect(Result.isFailure(Schema.encodeUnknownResult(number)({ one: { left: "known" } }))).toBe(
    true
  );
  expect(
    Result.isSuccess(Schema.encodeUnknownResult(symbolOrNumber)({ [symbolKey]: { left: "known" } }))
  ).toBe(true);
});

it("does not use a mismatched union member to treat partial input as complete", () => {
  const checkedInput = Schema.Struct({
    choice: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("detailed"),
        detail: Schema.Struct({ left: Schema.String, right: Schema.String }),
      }),
      Schema.Struct({ kind: Schema.Literal("simple") }),
    ]),
    label: Schema.String,
  }).check(
    Schema.makeFilter((input) =>
      input.label === "allowed" ? undefined : { path: ["label"], issue: "Expected allowed" }
    )
  );
  const partial = makePartialInputSchema(checkedInput);
  const incomplete = Schema.encodeUnknownResult(partial)({
    choice: { kind: "detailed" },
    label: "blocked",
  });
  const complete = Schema.encodeUnknownResult(partial)({
    choice: {
      kind: "detailed",
      detail: { left: "known", right: "known" },
    },
    label: "blocked",
  });

  expect(Result.isSuccess(incomplete)).toBe(true);
  expect(Result.isFailure(complete)).toBe(true);
});

it("does not select a shallower overlapping union member through excess properties", () => {
  const checkedInput = Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("entry"),
      detail: Schema.Struct({ left: Schema.String, right: Schema.String }),
    }),
    Schema.Struct({ kind: Schema.Literal("entry") }),
  ]).check(Schema.makeFilter(() => ({ path: [], issue: "Expected allowed" })));
  const partial = makePartialInputSchema(checkedInput);
  const incomplete = Schema.encodeUnknownResult(partial)({
    kind: "entry",
    detail: { left: "known" },
  });
  const complete = Schema.encodeUnknownResult(partial)({
    kind: "entry",
    detail: { left: "known", right: "known" },
  });

  expect(Result.isSuccess(incomplete)).toBe(true);
  expect(Result.isFailure(complete)).toBe(true);
});

it("delays enclosing checks until fixed and variadic tuple members are complete", () => {
  const member = Schema.Struct({ left: Schema.String, right: Schema.String });
  const checkedInput = Schema.Struct({
    fixed: Schema.Tuple([member, Schema.Finite]),
    variadic: Schema.TupleWithRest(Schema.Tuple([member]), [member, member]),
    label: Schema.String,
  }).check(
    Schema.makeFilter((input) =>
      input.label === "allowed" ? undefined : { path: ["label"], issue: "Expected allowed" }
    )
  );
  const partial = makePartialInputSchema(checkedInput);
  const incompleteFixed = Schema.encodeUnknownResult(partial)({
    fixed: [{ left: "known" }, 1],
    variadic: [
      { left: "known", right: "known" },
      { left: "known", right: "known" },
    ],
    label: "blocked",
  });
  const incompleteVariadic = Schema.encodeUnknownResult(partial)({
    fixed: [{ left: "known", right: "known" }, 1],
    variadic: [{ left: "known", right: "known" }, { left: "known" }],
    label: "blocked",
  });
  const complete = Schema.encodeUnknownResult(partial)({
    fixed: [{ left: "known", right: "known" }, 1],
    variadic: [
      { left: "known", right: "known" },
      { left: "known", right: "known" },
    ],
    label: "blocked",
  });

  expect(Result.isSuccess(incompleteFixed)).toBe(true);
  expect(Result.isSuccess(incompleteVariadic)).toBe(true);
  expect(Result.isFailure(complete)).toBe(true);
});

it("delays array and union checks while their selected nested input is incomplete", () => {
  const member = Schema.Struct({ left: Schema.String, right: Schema.String });
  const rejected = Schema.makeFilter(() => ({ path: [], issue: "Expected allowed" }));
  const partialArray = makePartialInputSchema(Schema.Array(member).check(rejected));
  const partialUnion = makePartialInputSchema(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("object"), value: member }),
      Schema.Struct({ kind: Schema.Literal("text"), value: Schema.String }),
    ]).check(rejected)
  );

  expect(Result.isSuccess(Schema.encodeUnknownResult(partialArray)([{ left: "known" }]))).toBe(
    true
  );
  expect(
    Result.isFailure(Schema.encodeUnknownResult(partialArray)([{ left: "known", right: "known" }]))
  ).toBe(true);
  expect(
    Result.isSuccess(
      Schema.encodeUnknownResult(partialUnion)({ kind: "object", value: { left: "known" } })
    )
  ).toBe(true);
  expect(
    Result.isFailure(
      Schema.encodeUnknownResult(partialUnion)({
        kind: "object",
        value: { left: "known", right: "known" },
      })
    )
  ).toBe(true);
});

it("retains tuple arity and order while partialing nested tuple values", () => {
  type TupleObject = {
    readonly left: string;
    readonly right: string;
  };
  type PartialTupleObject = Partial<TupleObject>;
  type InputTuple = readonly [TupleObject, number];
  type PartialTuple = readonly [PartialTupleObject, number];
  type VariadicInputTuple = readonly [TupleObject, ...Array<TupleObject>, number];
  type PartialVariadicTuple = readonly [PartialTupleObject, ...Array<PartialTupleObject>, number];

  expectTypeOf<PartialInput<InputTuple>>().toEqualTypeOf<PartialTuple>();
  expectTypeOf<PartialInput<VariadicInputTuple>>().toEqualTypeOf<PartialVariadicTuple>();
  expectTypeOf<PartialInput<Option.Option<TupleObject>>>().toEqualTypeOf<
    Option.Option<TupleObject>
  >();

  const partial = makePartialInputSchema(
    Schema.Tuple([Schema.Struct({ left: Schema.String, right: Schema.String }), Schema.Finite])
  );
  const nestedPartial = Schema.encodeUnknownResult(partial)([{ left: "known" }, 1]);
  const wrongArity = Schema.encodeUnknownResult(partial)([{ left: "known" }, 1, 2]);
  const wrongOrder = Schema.encodeUnknownResult(partial)([1, { left: "known" }]);

  expect(Result.isSuccess(nestedPartial)).toBe(true);
  expect(Result.isFailure(wrongArity)).toBe(true);
  expect(Result.isFailure(wrongOrder)).toBe(true);
});
