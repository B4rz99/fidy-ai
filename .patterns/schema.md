# Schema (v4)

How `effect` v4 Schema actually works, read from the source. Citations are `<path>:<line>`
relative to `packages/effect/`, except `migration/schema.md` (repo root), which is the
canonical v3→v4 rename map — read it before trusting any v3 muscle memory. Schema lives in
core `effect` (`Schema`, `SchemaAST`, `SchemaIssue`, `SchemaTransformation`, `SchemaGetter`,
`SchemaError` are all top-level stable modules), not in a separate `@effect/schema` package.

## v3 → v4 in one breath

Variadic APIs became array-taking: `Union([A, B])`, `Literals(["a", "b"])`, `Tuple([A, B])`
(`migration/schema.md` summary table). `filter` → `check(...)` with `is*`-prefixed
primitives (`isUUID`, `isPattern`, `isBetween`, …); `annotations()` → `annotate()`
(`Schema.ts:537`); `pick/omit/partial/extend` → `mapFields` + `Struct.pick/omit/map/assign`;
`transform/transformOrFail` → `from.pipe(Schema.decodeTo(to, transformation))`
(`Schema.ts:5457`); `parseJson(s)` → `fromJsonString(s)` (`Schema.ts:11083`). Decoding APIs:
`decodeUnknownEffect` (`Schema.ts:1368`), `decodeUnknownExit` (`:1475`),
`decodeUnknownSync` (`:1767`, throws), plus `is` (`:1299`) and `asserts`. All failures carry
`SchemaError { issue: SchemaIssue.Issue }` (`SchemaError.ts:41`). `positive`/`nonNegative`
filters are gone — use `isGreaterThanOrEqualTo(0)` / the BigDecimal variants.

`ParseOptions.errors` defaults to `"first"` (`SchemaAST.ts:470`); pass `{ errors: "all" }`
at every user-facing boundary or you report one field problem at a time.
`onExcessProperty` defaults to `"ignore"` (strips unknown keys — silent, but lossless
decode needs `"error"` if you care).

## One schema, many artifacts

A canonical entity schema derives everything else; nothing is written twice:

| Artifact           | API                                                                         | Notes                                                                                                             |
| ------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| JSON codec         | `Schema.toCodecJson(S)` (`Schema.ts:13478`)                                 | `Encoded = Json`; declarations use their `toCodecJson` annotation (BigDecimal → string, `Schema.ts:10902`)        |
| String-keyed codec | `Schema.toCodecStringTree(S)` (`Schema.ts:13627`)                           | what httpapi applies to params/query/headers                                                                      |
| JSON-string codec  | `Schema.fromJsonString(S)` (`Schema.ts:11083`)                              | `JSON.parse` then decode through `S` **as-is** — wrap `toCodecJson(S)` first unless `S` is already JSON-encodable |
| JSON Schema        | `Schema.toJsonSchemaDocument(S)` (`Schema.ts:13426`)                        | draft 2020-12, describes the **encoded** (JSON) side via the representation layer (`Schema.ts:13325`)             |
| Equivalence        | `Schema.toEquivalence(S)` (`Schema.ts:13309`)                               | BigDecimal compares scale-insensitively (`BigDecimal.ts:1193`)                                                    |
| Arbitrary          | `Schema.toArbitrary(S)` (`Schema.ts:13079`)                                 | respects ordered BigDecimal check constraints                                                                     |
| Standard Schema    | `toStandardSchemaV1` / `toStandardJSONSchemaV1` (`Schema.ts:1156`, `:1235`) | for third-party libs                                                                                              |

## Structs, optionality, constructors

- `optionalKey(S)` = exact optional (`age?: number`, key may be absent, `Schema.ts:2319`);
  `optional(S)` = `optionalKey(UndefinedOr(S))` (`:2386`). Nullable DB columns are
  `NullOr(S)` (`:4893`) — three distinct shapes; model which one you mean, no defaults.
  `requiredKey` reverses `optionalKey` (`:2340`).
- Fields are readonly by default; `withDecodingDefaultType(Effect.succeed(x))`
  (`Schema.ts:5932`) is the "default on decode" tool — deliberate, visible, not a fallback.
- Constructors: every schema has `.make(input)` (throws on invalid, `Schema.ts:211`),
  `.makeOption` (`:235`), `.makeEffect` (`:248`). `withConstructorDefault` (`:5695`) makes a
  field omittable in `make` only — decode still requires it.
- `Schema.Class<Self>("Id")({ ...fields })` (`Schema.ts:12805`) gives a validated-construction
  data class with schema-derived codecs; `TaggedClass` (`:12865`) adds `_tag`. Plain
  `Struct`s are sufficient for pure data; classes buy methods + nominal identity.

## Checks, brands, sibling-dependent validation

- `.check(c1, c2, ...)` appends filters without changing the type (`Schema.ts:5013`);
  `refine(guard)` narrows it (`:5062`). Primitives: `isUUID` (`:6676`), `isPattern`
  (`:6576`), `isGreaterThanOrEqualToBigDecimal` etc. (`:7913`, `:7952`).
- Reusable checks are plain values (`SchemaAST.Filter<T>`) — export them from one module and
  `.check(...)` them onto any schema of that type.
- **Brands add zero runtime checks** (`Schema.ts:5120` Gotchas) — compose:
  `Schema.String.check(Schema.isUUID()).pipe(Schema.brand("UserId"))`. There is no prebuilt
  branded-UUID schema. `fromBrand` (`:5132`) reuses a `Brand.Constructor`'s checks.
- **Struct-level checks see the whole decoded value** — this is how currency-dependent
  precision works. `makeFilter` (`Schema.ts:6448`) may return `undefined`/`true`, `false`, a
  message string, `{ path, issue }` to blame a specific field, or an array of those to
  report several at once (`FilterOutput`, `:6500`; worked examples in
  `migration/schema.md` § filter). Verified: a check on
  `Struct({ currency, amount })` returning `{ path: ["amount"], issue: "..." }` produces a
  properly-pathed field error. Struct checks run after all fields decode.
- Checks attached to the **from** side of a transformation run on decode input AND on
  encode output — an encode that produces text violating the check fails loudly (verified;
  this is the mechanism that makes a Money text-format contract bidirectional).

## Deriving schemas (`mapFields`) — a trap

`Base.mapFields(Struct.omit(["id", "createdAt"]))` is the idiom (`Schema.ts:3395-3414`);
`fieldsAssign` extends (`:3493`); make a field optional in the derived shape with
`Struct.mapPick(["categoryId"], Schema.optionalKey)`. What survives: **field-level** checks,
brands, annotations, and transformations (they live on the field schemas — verified). What
does NOT survive: **struct-level `.check(...)`s** (dropped unless
`{ unsafePreserveChecks: true }`, `:3398`, unsafe because the check may read removed fields)
and **struct-level annotations, including `identifier`** (verified: `mapFields` builds a
fresh AST). Re-annotate and re-check every derived schema:
`CreateTransactionInput = Transaction.mapFields(...).check(...).annotate({ identifier: "CreateTransactionInput" })`.

## Discriminated unions

- `Schema.tag("bar")` = `Literal("bar")` + constructor default (`Schema.ts:5974`) — the tag
  is omittable in `make` but **required in decode input**. `tagDefaultOmit` also strips it
  on encode (`:6010`). `TaggedStruct(tag, fields)` hardcodes the key `_tag` (`:6070`), as
  does `TaggedUnion({ Circle: {...} })` (`:6259`) — for fidy's `type`-discriminated widgets
  use plain structs with `type: Schema.tag("bar_chart")` and
  `Schema.Union([...]).pipe(Schema.toTaggedUnion("type"))` (`:6149`), which works with any
  tag key and adds `cases`, `guards`, `isAnyOf`, and exhaustive `match`.
- Union parsing narrows candidates by non-optional literal "sentinel" fields via a cached
  index (`SchemaAST.ts:2474`, `:2567`) — a 20-member widget union costs one map lookup, and
  members are only tried when their sentinel matches.
- `Union(members, { mode: "oneOf" })` fails when multiple members match; default `anyOf`
  takes the first (`SchemaAST.ts:2624`).
- **Error-quality trap**: when NO candidate matches (unknown or missing `type`), the parser
  raises `AnyOf(ast, input, [])` with zero member issues (`SchemaAST.ts:2671`), and the
  formatter renders one **root-path** issue containing the whole expected-union blurb and
  the entire rejected value (`SchemaIssue.ts:1041-1048`) — no field path. When the sentinel
  DOES match, member field errors come out properly pathed (verified). If a friendly
  "unknown widget type" message matters, pre-check the tag with a `Literals` schema or catch
  the empty `AnyOf`.

## BigDecimal and Money — what stock codecs give, what must be built

`Schema.BigDecimal` validates in-memory instances (`Schema.ts:10890`);
`Schema.BigDecimalFromString` is `String → BigDecimal` via
`SchemaTransformation.bigDecimalFromString` (`Schema.ts:10966`,
`SchemaTransformation.ts:1400`), i.e. decode = `BigDecimal.fromString`, encode =
`BigDecimal.format`. `toCodecJson` on any struct containing `Schema.BigDecimal` uses the
same pair (declaration annotation, `Schema.ts:10902`). Measured behavior:

- **Decode (`fromString`, `BigDecimal.ts:1378`) is far laxer than fidy's Money text rule.**
  It accepts empty string (→ zero, `:1379`), exponent notation (`"1e3"` → 1000), leading
  `+`, leading zeros (`"00042"`), bare `".5"` / `"5."` (regex `BigDecimal.ts:23`). It
  rejects whitespace, `_` separators, `NaN`/`Infinity`, double dots. It does **not**
  normalize — `"0.10"` decodes with scale 2.
- **Encode (`format`, `BigDecimal.ts:1485`) normalizes first** — trailing zeros are
  stripped: `BigDecimal("25000.00")` encodes to `"25000"` — **but switches to exponent
  notation when |normalized scale| ≥ 16** (`:1487-1489`, `toExponential` `:1537`):
  `1e16` → `"1e+16"`, `0.0000000000000001` → `"1e-16"`. Never locale-formatted.
- Comparison/equality are scale-insensitive: `Order` (`BigDecimal.ts:683`), `Equivalence`
  (`:1193`), and `Equal.symbol` (`:63`) all treat `0.10 = 0.1`; `normalize` (`:195`) is
  cheap and cached on the instance.

**Verdict for fidy Money**: the stock transformation is the right primitive but needs a
gate. Build `AmountText = Schema.String.check(Schema.isPattern(CANONICAL_DECIMAL_RE))` and
pipe it: `AmountText.pipe(Schema.decodeTo(Schema.BigDecimal,
SchemaTransformation.bigDecimalFromString))`. The pattern check rejects exponent/empty/`+`
input on decode, and — because from-side checks also run on encode output — a formatted
`"1e+16"` fails the encode instead of leaking (verified). The scale ≥ 16 branch is
unreachable once currency precision checks bound the scale, but the check makes that a
loud invariant rather than an assumption. Currency-dependent precision is a struct-level
`makeFilter` on `{ amount, currency }` testing `BigDecimal.normalize(amount).scale <=
precision(currency)` with `{ path: ["amount"], issue }`. Positivity is contextual:
`Money.check(...)` would apply everywhere, so keep zero-permitting Money shared and add
`isGreaterThanBigDecimal(zero)`-style checks (`Schema.ts:7901`) in the owning schemas — but
note those are struct-level once they target a field of a shared sub-schema, so they are
subject to the `mapFields` drop trap above.

## Field-level errors: `{ path, message }[]`

`SchemaIssue.makeFormatterStandardSchemaV1()` (`SchemaIssue.ts:994`) flattens any issue tree
into `{ message, path: PropertyKey[] }` entries — exactly fidy's error contract. Idiom:

```ts
Schema.decodeUnknownEffect(S, { errors: "all" })(input).pipe(
  Effect.catchTag("SchemaError", (e) =>
    Effect.fail(makeValidationError(SchemaIssue.makeFormatterStandardSchemaV1()(e.issue).issues))
  )
);
```

Verified output for a two-field failure: `[{ path: ["currency"], message: "Expected \"USD\" |
\"COP\", got \"EUR\"" }, { path: ["amount"], message: "Invalid BigDecimal string: x" }]`.
`makeFormatterDefault` (`:1100`) renders the same tree as a multi-line string (what
`SchemaError.message` uses, `SchemaError.ts:48-50`). Custom messages: `message`/`expected`
annotations on schemas and checks feed the formatter (`Schema.ts:14260` lists annotation
keys); per-issue hooks via `leafHook`/`checkHook`.

## JSON Schema for LLM structured outputs

`Schema.toJsonSchemaDocument(S)` targets draft 2020-12 and describes the **JSON-encoded**
form (it routes through the representation layer, `Schema.ts:13426`, `:13325`) — safe to
feed an LLM and decode its output through the same canonical schema. Measured mappings:
`identifier` annotation → `$ref` + a named definition (annotate every shared entity or
everything inlines); `Literals` → `enum`; structs → `additionalProperties: false` +
`required`; `isUUID` → `pattern` + `format: "uuid"`; brands invisible; struct-level
`makeFilter` checks are **silently lossy** (nothing to express them in JSON Schema).
`BigDecimal` emits bare `{ "type": "string" }` — annotate the amount's string side with
`description`/`pattern` or the model has no format hint. `toStandardJSONSchemaV1`
(`Schema.ts:1235`) exists for libraries that expect the standard wrapper.

## Decoding stored documents (Postgres rows, jsonb, LLM output)

- **jsonb / LLM JSON (already-parsed values)**: decode with
  `Schema.decodeUnknownEffect(Schema.toCodecJson(Doc), { errors: "all" })`; write back
  through `Schema.encodeUnknownEffect(Schema.toCodecJson(Doc))` — encode-on-write is the
  cheap insurance that the document matches the schema before it hits the DB, since encode
  runs the same checks in reverse (verified: encode fails on check-violating values).
- **JSON in a text column / raw LLM string**: `Schema.fromJsonString(Schema.toCodecJson(Doc))`
  — `fromJsonString` alone does NOT apply JSON codecs, it decodes the parsed value through
  the schema as given (`Schema.ts:11083-11092`); with a BigDecimal-typed field that fails.
  It does annotate `contentMediaType`/`contentSchema` so JSON Schema generation stays
  accurate (`:11086-11091`).
- **Row structs**: plain `decodeUnknownEffect(RowSchema)` on driver output; model nullable
  columns as `NullOr`, absent-vs-null distinctly.
- Deep equality for decoded documents: `Schema.toEquivalence(Doc)` — respects declaration
  equivalences (BigDecimal scale-insensitive), unlike naive JSON comparison.
