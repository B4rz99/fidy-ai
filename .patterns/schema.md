# Schema (v4)

Selected sources: `node_modules/effect/src/Schema.ts`, `SchemaAST.ts`, `SchemaIssue.ts`,
`SchemaTransformation.ts`, `SchemaGetter.ts`, `Arbitrary.ts`, and `schema/Model.ts` under that same
source directory. Use named symbols rather than old RC line numbers. Schema is part of `effect`;
Model and schema compilers are under `effect/schema`.

## Define and decode the owned boundary

Use `Schema.Struct`, `Schema.Class`, or `Schema.TaggedErrorClass` according to the boundary's needs.
Array-taking APIs include `Union([A, B])`, `Literals(["a", "b"])`, and `Tuple([A, B])`.
Attach checks with `.check(...)` and metadata with `.annotate(...)`.

- `decodeUnknownEffect` reports `Schema.SchemaError`; `decodeUnknownResult` is a synchronous,
  non-throwing alternative for service-free decoding. `decodeUnknownSync` throws.
- `errors: "all"` collects field issues; default parsing reports the first error.
- `onExcessProperty: "ignore"` is the default and strips unknown keys. Use `"error"` when the
  boundary requires rejection rather than dropping extra input.
- `optionalKey(S)` permits absence; `optional(S)` also permits `undefined`; `NullOr(S)` permits
  null. Preserve these distinctions rather than adding accidental defaults.
- Constructor defaults affect `.make`; decoding defaults deliberately change input acceptance.
- `Schema.Redacted` transforms its inner value. `disallowJsonEncode: true` forbids that JSON
  encoding path; redaction itself is not encryption or authorization.

## JSON and generated artifacts

| Need                                    | API                                                    |
| --------------------------------------- | ------------------------------------------------------ |
| JSON-compatible value codec             | `Schema.toCodecJson(S)`                                |
| JSON text containing that value         | `Schema.fromJsonString(Schema.toCodecJson(S))`         |
| Query/header/string-tree representation | `Schema.toCodecStringTree(S)`                          |
| JSON Schema                             | `Schema.toJsonSchemaDocument(S, options)`              |
| Semantic equality                       | `Schema.toEquivalence(S)`                              |
| Generated decoded fixtures              | `Arbitrary.schema(S)` from `effect/Arbitrary`          |
| Third-party Standard Schema contract    | `Schema.toStandardSchemaV1` / `toStandardJSONSchemaV1` |

`fromJsonString(S)` alone parses JSON and applies S as supplied; it does not first derive a JSON
codec. Encode stored documents through the same owned codec used to decode them.

JSON Schema describes the encoded representation and cannot express every runtime check. Keep
explicit `identifier` annotations for reusable definitions. Brands do not supply them. Struct-level
custom checks can be absent from generated JSON Schema; actual decoding remains authoritative.
Compare generated contracts against decoding when changing checks or optionality.

## Checks, transformations, and brands

Use `SchemaTransformation.transform` for pure mappings and `transformEffect` when either direction
can fail or require services. Compose with `Schema.decodeTo`; effectful transformations fail with
`SchemaIssue.Issue`, not an arbitrary domain error. Place checks on the correct side: encoded-side
checks run on decode input and encode output.

Current checks include `isStartingWith`, `isBetweenLength`, `isPattern`, and numeric/BigDecimal
variants. String length checks count UTF-16 units. Pattern projection to JSON Schema supports a
restricted Unicode-mode regex subset; verify both runtime acceptance and generated output when
changing flags.

`Schema.brand("Id")` adds a nominal TypeScript type only: no runtime validation or AST annotation.
Compose it with checks and an explicit identifier. `Schema.fromBrand(identifier, constructor)` can
reuse a Brand constructor's checks; it is not the same operation as a type-only brand.

Struct-level `Schema.makeFilter` sees decoded fields and can report `{ path, issue }` for a specific
field. Recheck derived structs: `mapFields` preserves field schemas, but drops struct checks unless
`unsafePreserveChecks` is requested and does not preserve the original struct annotations. Prefer
reattaching checks and identifiers deliberately over preserving checks that may read removed fields.

## Tagged unions and field errors

`Schema.tag` supplies a constructor default, not an optional decode field. `TaggedStruct` uses
`_tag`; for another discriminator use ordinary structs plus `Schema.toTaggedUnion("type")`.
`Union(..., { mode: "oneOf" })` rejects overlapping matches; default `anyOf` accepts the first.

A missing or unknown discriminator can produce a root-level union issue rather than a field error.
Use `SchemaIssue.makeFormatterStandardSchemaV1()` for `{ path, message }` issues, then project the
boundary's safe error. Formatter messages may include rejected input: never publish raw schema
errors containing credentials or provider data.

## Money: reuse the existing codec

`apps/server/src/core/_shared/money.ts` owns Money and Currency. Its codec validates non-negative
plain decimal text, encodes normalized **non-exponent** text, and checks fractional precision against
the Currency. Zero is valid until the owning operation requires a positive amount.

Reuse `Money`, its JSON codec, and `encodeMoneyAmount`; do not reconstruct them with the stock
BigDecimal transformation. `BigDecimal.fromString` accepts spellings Money forbids, while
`BigDecimal.format` can produce exponent notation for large magnitudes as well as small fractions.
Currency precision does not prevent the large-magnitude branch. `money.test.ts` is the regression
seam for round trips, Currency mismatch, precision, and canonical text.

## Model and compilers

`Model` from `effect/schema` derives coordinated database and JSON variants. Use it only when one
owned record genuinely needs those variants; `GeneratedByDb` is an inclusion rule, not a database
generator, and `Sensitive` is JSON omission, not storage protection.

The WhatsApp webhook uses `Model.optionalOption(S)`: absent **or null** becomes `Option.none`.
Use explicit optionality/null schemas when that distinction matters.

`SchemaCompiler`, `SchemaJITCompiler`, and `SchemaAOTCompiler` also live in `effect/schema`.
They install operations for exact AST identities into the normal parser registry. JIT falls back
when code generation is unavailable; AOT output must be installed with matching ASTs in the original
order. Regenerate on schema/Effect changes and install before consumers capture parser entries.
Adopt compilation only after measuring the actual boundary; ordinary Schema semantics remain the
contract.
