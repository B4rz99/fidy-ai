# Schema (v4)

How `effect` v4 Schema actually works, read from the source. Citations are `<path>:<line>`
relative to `packages/effect/`, except `migration/schema.md` (repo root), which is the
canonical v3→v4 rename map — read it before trusting any v3 muscle memory. Schema lives in
core `effect` (`Schema`, `SchemaAST`, `SchemaIssue`, `SchemaTransformation`, and `SchemaGetter`
are top-level stable modules), not in a separate `@effect/schema` package. `SchemaError` is the
`Schema.SchemaError` class, exported from `Schema.ts`; RC.112 removed the separate
`effect/SchemaError` module.

## v3 → v4 in one breath

Variadic APIs became array-taking: `Union([A, B])`, `Literals(["a", "b"])`, `Tuple([A, B])`
(`migration/schema.md` summary table). `filter` → `check(...)` with `is*`-prefixed
primitives (`isUUID`, `isPattern`, `isBetween`, …); `annotations()` → `annotate()`
(`Schema.ts:653-654`); `pick/omit/partial/extend` → `mapFields` + `Struct.pick/omit/map/assign`;
`transform/transformOrFail` → `from.pipe(Schema.decodeTo(to, transformation))`
(`Schema.ts:5585-5601`); `parseJson(s)` → `fromJsonString(s)` (`Schema.ts:12756-12797`). Decoding APIs:
`decodeUnknownEffect` (`Schema.ts:1516`), `decodeUnknownExit` (`:1635`),
`decodeUnknownSync` (`:1920`, throws), plus `is` and `asserts`. Effect/Exit/synchronous adapters
wrap schema mismatches in `Schema.SchemaError { issue: SchemaIssue.Issue }`
(`Schema.ts:1148-1223`). `positive`/`nonNegative`
filters are gone — use `isGreaterThanOrEqualTo(0)` / the BigDecimal variants.

`ParseOptions.errors` defaults to `"first"` (`SchemaAST.ts:470`); pass `{ errors: "all" }`
at every user-facing boundary or you report one field problem at a time.
`onExcessProperty` defaults to `"ignore"` (strips unknown keys — silent, but lossless
decode needs `"error"` if you care).

## One schema, many artifacts

A canonical entity schema derives everything else; nothing is written twice:

| Artifact           | API                                                                         | Notes                                                                                                             |
| ------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| JSON codec         | `Schema.toCodecJson(S)` (`Schema.ts:15366-15373`)                           | `Encoded = Json`; declarations use their `toCodecJson` annotation (BigDecimal → string, `Schema.ts:12647-12665`)  |
| String-keyed codec | `Schema.toCodecStringTree(S)` (`Schema.ts:15541-15586`)                     | what httpapi applies to params/query/headers                                                                      |
| JSON-string codec  | `Schema.fromJsonString(S)` (`Schema.ts:12756-12797`)                        | `JSON.parse` then decode through `S` **as-is** — wrap `toCodecJson(S)` first unless `S` is already JSON-encodable |
| JSON Schema        | `Schema.toJsonSchemaDocument(S)` (`Schema.ts:15299-15307`)                  | draft 2020-12, describes the **encoded** (JSON) side via the representation layer (`Schema.ts:15170-15174`)       |
| Equivalence        | `Schema.toEquivalence(S)` (`Schema.ts:15143-15145`)                         | BigDecimal compares scale-insensitively (`BigDecimal.ts:1103`)                                                    |
| Arbitrary          | `Schema.toArbitrary(S)` (`Schema.ts:14926-14930`)                           | respects ordered BigDecimal check constraints                                                                     |
| Standard Schema    | `toStandardSchemaV1` / `toStandardJSONSchemaV1` (`Schema.ts:1299`, `:1378`) | for third-party libs                                                                                              |

## Structs, optionality, constructors

- `optionalKey(S)` = exact optional (`age?: number`, key may be absent, `Schema.ts:2395-2445`);
  `optional(S)` = `optionalKey(UndefinedOr(S))` (`:2473-2513`). Nullable DB columns are
  `NullOr(S)` (`:4997-5012`) — three distinct shapes; model which one you mean, no defaults.
  `requiredKey` reverses `optionalKey` (`:2465`).
- Fields are readonly by default; `withDecodingDefaultType(Effect.succeed(x))`
  (`Schema.ts:6025-6064`) is the "default on decode" tool — deliberate, visible, not a fallback.
- Constructors: every schema has `.make(input)` (throws on invalid, `Schema.ts:211`),
  `.makeOption` (`:235`), `.makeEffect` (`:248`). `withConstructorDefault` (`:5775-5829`) makes a
  field omittable in `make` only — decode still requires it.
- `Schema.Class<Self>("Id")({ ...fields })` (`Schema.ts:14317-14670`) gives a validated-construction
  data class with schema-derived codecs; `TaggedClass` (`:14720`) adds `_tag`. Plain
  `Struct`s are sufficient for pure data; classes buy methods + nominal identity.

## Checks, brands, sibling-dependent validation

- `.check(c1, c2, ...)` appends filters without changing the type (`Schema.ts:5135-5145`);
  `refine(guard)` narrows it (`:5147-5189`). Primitives: `isUUID` (`:7032`), `isPattern`
  (`:6820`), `isGreaterThanOrEqualToBigDecimal` etc. (`:8793-8808`).
- Reusable checks are plain values (`SchemaAST.Filter<T>`) — export them from one module and
  `.check(...)` them onto any schema of that type.
- **Brands add zero runtime checks** (`Schema.ts:5200-5244`) — compose:
  `Schema.String.check(Schema.isUUID()).pipe(Schema.brand("UserId"))`. There is no prebuilt
  branded-UUID schema. `fromBrand` (`:5254-5258`) reuses a `Brand.Constructor`'s checks.
- **Struct-level checks see the whole decoded value** — this is how currency-dependent
  precision works. `makeFilter` (`Schema.ts:6659-6671`) may return `undefined`/`true`, `false`, a
  message string, `{ path, issue }` to blame a specific field, or an array of those to
  report several at once (`FilterOutput`, `:6712-6720`; worked examples in
  `migration/schema.md` § filter). Verified: a check on
  `Struct({ currency, amount })` returning `{ path: ["amount"], issue: "..." }` produces a
  properly-pathed field error. Struct checks run after all fields decode.
- Checks attached to the **from** side of a transformation run on decode input AND on
  encode output — an encode that produces text violating the check fails loudly (verified;
  this is the mechanism that makes a Money text-format contract bidirectional).

## Deriving schemas (`mapFields`) — a trap

`Base.mapFields(Struct.omit(["id", "createdAt"]))` is the idiom (`Schema.ts:3510-3551`);
`fieldsAssign` extends (`:3622-3624`); make a field optional in the derived shape with
`Struct.mapPick(["categoryId"], Schema.optionalKey)`. What survives: **field-level** checks,
brands, annotations, and transformations (they live on the field schemas — verified). What
does NOT survive: **struct-level `.check(...)`s** (dropped unless
`{ unsafePreserveChecks: true }`, `:3517-3524`, unsafe because the check may read removed fields)
and **struct-level annotations, including `identifier`** (verified: `mapFields` builds a
fresh AST). Re-annotate and re-check every derived schema:
`CreateTransactionInput = Transaction.mapFields(...).check(...).annotate({ identifier: "CreateTransactionInput" })`.

## Discriminated unions

- `Schema.tag("bar")` = `Literal("bar")` + constructor default (`Schema.ts:6076-6102`) — the tag
  is omittable in `make` but **required in decode input**. `tagDefaultOmit` also strips it
  on encode (`:6123-6137`). `TaggedStruct(tag, fields)` hardcodes the key `_tag` (`:6145-6202`), as
  does `TaggedUnion({ Circle: {...} })` (`:6403-6477`) — for fidy's `type`-discriminated widgets
  use plain structs with `type: Schema.tag("bar_chart")` and
  `Schema.Union([...]).pipe(Schema.toTaggedUnion("type"))` (`:6283-6319`), which works with any
  tag key and adds `cases`, `guards`, `isAnyOf`, and exhaustive `match`.
- Union parsing narrows candidates by non-optional literal "sentinel" fields via a cached
  index (`SchemaAST.ts:2680-2703`, `:2715-2860`) — a 20-member widget union costs one map lookup, and
  members are only tried when their sentinel matches.
- `Union(members, { mode: "oneOf" })` fails when multiple members match; default `anyOf`
  takes the first (`SchemaAST.ts:2890-2975`).
- **Error-quality trap**: when NO candidate matches (unknown or missing `type`), the parser
  raises `AnyOf(ast, input, [])` with zero member issues (`SchemaAST.ts:2965-2974`), and the
  formatter renders one **root-path** issue containing the whole expected-union blurb and
  the entire rejected value (`SchemaIssue.ts:1084-1092`) — no field path. When the sentinel
  DOES match, member field errors come out properly pathed (verified). If a friendly
  "unknown widget type" message matters, pre-check the tag with a `Literals` schema or catch
  the empty `AnyOf`.

## BigDecimal and Money — what stock codecs give, what must be built

`Schema.BigDecimal` validates in-memory instances (`Schema.ts:12547-12665`);
`Schema.BigDecimalFromString` is `String → BigDecimal` via
`SchemaTransformation.bigDecimalFromString` (`Schema.ts:12710-12742`,
`SchemaTransformation.ts:1440-1455`), i.e. decode = `BigDecimal.fromString`, encode =
`BigDecimal.format`. `toCodecJson` on any struct containing `Schema.BigDecimal` uses the
same pair (declaration annotation, `Schema.ts:12647-12665`). Measured behavior:

- **Decode (`fromString`, `BigDecimal.ts:1277-1324`) is far laxer than fidy's Money text rule.**
  It accepts empty string (→ zero, `:1278-1280`), exponent notation (`"1e3"` → 1000), leading
  `+`, leading zeros (`"00042"`), bare `".5"` / `"5."` (parsing logic `BigDecimal.ts:1285-1317`). It
  rejects whitespace, `_` separators, `NaN`/`Infinity`, double dots. It does **not**
  normalize — `"0.10"` decodes with scale 2.
- **Encode (`format`, `BigDecimal.ts:1381-1411`) normalizes first** — trailing zeros are
  stripped: `BigDecimal("25000.00")` encodes to `"25000"` — **but switches to exponent
  notation when |normalized scale| ≥ 16** (`:1382-1385`, `toExponential` `:1432-1449`):
  `1e16` → `"1e+16"`, `0.0000000000000001` → `"1e-16"`. Never locale-formatted.
- Comparison/equality are scale-insensitive: `Order` (`BigDecimal.ts:658`), `Equivalence`
  (`:1103`), and `Equal.symbol` (`:63`) all treat `0.10 = 0.1`; `normalize` (`:192`) is
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
`isGreaterThanBigDecimal(zero)`-style checks (`Schema.ts:8793-8800`) in the owning schemas — but
note those are struct-level once they target a field of a shared sub-schema, so they are
subject to the `mapFields` drop trap above.

## Field-level errors: `{ path, message }[]`

`SchemaIssue.makeFormatterStandardSchemaV1()` (`SchemaIssue.ts:1026-1034`) flattens any issue tree
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
`makeFormatterDefault` (`:1149-1154`) renders the same tree as a multi-line string (what
`Schema.SchemaError.message` uses, `Schema.ts:1193-1197`). Custom messages: `message`/`expected`
annotations on schemas and checks feed the formatter (`Schema.ts:16551-16637` lists annotation
keys); per-issue hooks via `leafHook`/`checkHook`.

## JSON Schema for LLM structured outputs

`Schema.toJsonSchemaDocument(S)` targets draft 2020-12 and describes the **JSON-encoded**
form (it routes through the representation layer, `Schema.ts:15299-15307`, `:15170-15174`) — safe to
feed an LLM and decode its output through the same canonical schema. Measured mappings:
`identifier` annotation → `$ref` + a named definition (annotate every shared entity or
everything inlines); `Literals` → `enum`; structs → `additionalProperties: false` +
`required`; `isUUID` → `pattern` + `format: "uuid"`; brands invisible; struct-level
`makeFilter` checks are **silently lossy** (nothing to express them in JSON Schema).
`BigDecimal` emits bare `{ "type": "string" }` — annotate the amount's string side with
`description`/`pattern` or the model has no format hint. `toStandardJSONSchemaV1`
(`Schema.ts:1378`) exists for libraries that expect the standard wrapper.

## Decoding stored documents (Postgres rows, jsonb, LLM output)

- **jsonb / LLM JSON (already-parsed values)**: decode with
  `Schema.decodeUnknownEffect(Schema.toCodecJson(Doc), { errors: "all" })`; write back
  through `Schema.encodeUnknownEffect(Schema.toCodecJson(Doc))` — encode-on-write is the
  cheap insurance that the document matches the schema before it hits the DB, since encode
  runs the same checks in reverse (verified: encode fails on check-violating values).
- **JSON in a text column / raw LLM string**: `Schema.fromJsonString(Schema.toCodecJson(Doc))`
  — `fromJsonString` alone does NOT apply JSON codecs, it decodes the parsed value through
  the schema as given (`Schema.ts:12756-12797`); with a BigDecimal-typed field that fails.
  It does annotate `contentMediaType`/`contentSchema` so JSON Schema generation stays
  accurate (`:12789-12795`).
- **Row structs**: plain `decodeUnknownEffect(RowSchema)` on driver output; model nullable
  columns as `NullOr`, absent-vs-null distinctly.
- Deep equality for decoded documents: `Schema.toEquivalence(Doc)` — respects declaration
  equivalences (BigDecimal scale-insensitive), unlike naive JSON comparison.
