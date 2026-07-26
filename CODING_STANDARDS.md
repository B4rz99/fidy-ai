# Coding standards

How code is written inside the shape described in [`ARCHITECTURE.md`](./ARCHITECTURE.md). Domain
vocabulary lives in [`CONTEXT.md`](./CONTEXT.md) — use those terms and avoid the synonyms they list.

---

## Naming

Bad names cause bugs. **A good name says what the entity is and what it is not.**

- **Precise.** `spentSoFar` beats `total`; `alreadyFired` beats `flags`.
- **Consistent.** One concept, one word, everywhere — the discipline `CONTEXT.md` applies to domain
  terms applies to code.
- **Two or three words.** If a name needs more, it is usually carrying two ideas.
- **If it is hard to name, the design is unclear.** Naming difficulty is a signal about the entity,
  not about vocabulary. Fix the boundary rather than reaching for a longer name.

|                                        |                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| files                                  | kebab-case — `needs-review.ts`                                                                                    |
| schemas, types, classes                | PascalCase                                                                                                        |
| functions, values                      | camelCase                                                                                                         |
| core decisions                         | verb-first — `decideAlerts`, `matchTransaction`, `applyEdit`                                                      |
| repo reads returning `Option`          | `find*` — `findBudget`                                                                                            |
| repo reads where absence is impossible | `get*`                                                                                                            |
| layers wiring the real thing           | `Live` suffix — `PgLive`, `ApiLive`                                                                               |
| layers wiring a test stack             | named for what they are — `ApiHarness`. `Live` marks the production wiring, so it would read as the opposite here |

---

## Comments

Presence is enforced in the core tree. **Quality is not, and quality is the whole point.**

**Interface comments** precede exported declarations and describe the abstraction: behaviour, what
the arguments _mean_ beyond their types, what the caller must guarantee, what it may rely on
afterwards, side effects, failures.

> The test: a caller should be able to use this correctly having read only the comment and the
> signature, **never the body**.

Interface comments must not describe implementation. **Field comments** carry what a name and type
cannot — units, ranges, invariants, lifecycle. **Implementation comments** live inside bodies and
never leak upward.

**Don't repeat the code.** A comment at the same level of abstraction as the declaration is worse
than none: it spends attention and returns nothing. The reference is `Money`'s comment: it should
explain that decimal text preserves exact monetary meaning across JSON, Currency controls allowed
fractional precision, zero is valid until an owning operation requires movement, and arithmetic
requires equal Currency. None of those obligations is recoverable from `{ amount, currency }`.

---

## Modelling

### Make illegal states unrepresentable

Beyond branded ids and refined primitives, model **cardinality and structure**: `NonEmptyArray`
where empty is illegal, `Tuple` where arity is fixed, `UniqueArray` where duplicates are, and
discriminated unions instead of optional-field combinations.

> **If two optional fields are always present together or always absent together, it is a union.**

`{ merged?: boolean, mergedIntoId?: TransactionId, mergedAt?: DateTime }` has eight representable
combinations and two legal ones. `Union(Unmerged, Merged({ intoId, at }))` has exactly two. Same for
the reconciliation outcome, the `NeedsReviewItem` lifecycle, and the dashboard's leaf-or-split node.

Unions are cheap to handle safely because a missing case is a build failure.

**This binds the model, not the storage.** A discriminated union rarely maps cleanly onto relational
columns, so the row schema may be flatter, and the repo's decode is where the two reconcile.

### Tuples

- **Fixed arity — yes.** If there are exactly three of something, do not type it as an array of
  unknown length.
- **Tuple _shape_ — the exception, with a reason.** `readonly [DateTime.Utc, DateTime.Utc]` for a
  range is worse than `{ from, to }`: nothing stops a swap, and the call site reads `range[0]`.
  Tuples earn their place where elements are genuinely positional and unnamed — `Object.entries`
  interop, SQL row shapes, Effect APIs that hand back pairs. Named struct is the default.

### Derived shapes

Any shape differing from the canonical one is **built from it** — `mapFields`, `Struct.omit`/`pick`,
or spreading `.fields`. A type that never mentions the schema it derives from is the smell. See
ARCHITECTURE.md §4.

Preserve nested value boundaries in core and contracts. A relational row may flatten Money into
adjacent exact amount and Currency columns, but its repo codec derives from the canonical Money
schema and reconstructs the nested value on read. Do not leak storage flattening into canonical
operations or define a parallel monetary DTO.

### Other defaults

- `Option` for absence. Never `null`. `undefined` only where an Effect API demands it.
- `ReadonlyArray<T>` in **return** types. Parameters are enforced in core; returns are not.
- `Data.struct` / `Data.tuple` for value objects needing structural equality.
- Effect's own collections (`Chunk`, `HashMap`) only where they earn it. `ReadonlyArray` is the
  default; reaching for `Chunk` on a twenty-element list is cargo cult.
- Local mutation is not banned — a small accumulator inside a pure function is sometimes clearer
  than a fold.

---

## Layout and file vocabulary

```
core/<slice>/     model.ts     the canonical schemas
                  rules.ts     pure decisions — omitted where there are none
                  errors.ts    the Data.TaggedError union

shell/<slice>/    contract.ts  HttpApiGroup, paths, scopes, cost classes
                  repo.ts      SQL and row schemas
                  handlers.ts  load → decide → persist
                  errors.ts    the exhaustive core→wire mapper
```

Reserved for those roles in **every** slice. A slice may add whatever else it needs —
`core/transactions/reconcile.ts`, `core/ingestion/anonymise.ts` — but a repo may not live in a file
called anything else. A session working on one issue should find things without exploring.

---

## Services vs plain functions

> **A `Context.Service` exists where there is something to construct, or something to substitute.
> Everything else is a plain function.**

|                                 | construct                               | substitute                             |                 |
| ------------------------------- | --------------------------------------- | -------------------------------------- | --------------- |
| repos                           | no — `SqlClient` is already the service | no — the API seam uses real Postgres   | plain function  |
| OpenAI · Kapso · Resend · Wompi | yes                                     | yes — the model is stubbed at the edge | service + layer |
| core                            | no                                      | no, and the type forbids it            | plain function  |

Repos are not services because the main thing that buys is substitution, and we have decided not to
substitute them. Thirteen unused substitution seams would sit there inviting someone to mock a repo.

### Classes only where an Effect API asks for one

`Data.TaggedError`, `Schema.ErrorClass` and `Context.Service` are all class-based, so classes are
everywhere and banning them would be nonsense. The line is what they are used **for**: declaring an
error or a service to Effect, never modelling behaviour and never sharing it by extension.

So: nothing this repo defines `extends` anything this repo defines, and two handlers that look
alike do not get an abstract base — the shared decision moves into a core function both call. This
is the composition half of the same rule the table above states for state.

`class` and `extends` are unrestricted by every gate in the repo, and the distinction is one no
linter could draw, so it lives here.

---

## Errors and absence

Two rules nothing can check:

- **`orDie` is for defects only.** A dead connection, yes. "Budget not found", no — that is a typed
  error that must reach the wire.
- **Absence is an `Option`, and the handler decides what it means.** The repo cannot know whether a
  missing budget is a 404, an upsert, or simply an empty answer. Use `findOneOption` for
  `SELECT … WHERE`; `findOne` only where absence is genuinely impossible, such as
  `INSERT … RETURNING`, where it is a defect and dying is right.

---

## Tests

Placement, tiers and responsibilities are in ARCHITECTURE.md §8. What review looks for:

- **Descriptions are behaviour sentences**, not method names: _"rejects exponent notation before
  storing Money"_ or _"rejects more fractional digits than the Currency permits"_, not
  _"Money validation"_.
- **Exercise the public interface.** Never mock an internal collaborator.
- **Core tests are not a loophole for testing the shell.** No mocked repos, no stubbed handlers.
  Wanting to test `handlers.ts` in isolation means a decision belongs in core.
- **Fixtures are builders with sensible defaults**, overridden per test with only the fields that
  matter, so a reader sees immediately what the test is about.
- **Prefer a derived guard over a hand-kept list** wherever the contracts can supply the list. The
  isolation and description tests both enumerate from the contract, so a new operation is covered
  without anyone remembering. The affordance check does not yet — see ARCHITECTURE.md §8.

---

## Agent-facing documentation

Presence is enforced; **voice is not**, and voice is what makes it useful.

`OpenApi.Description` flows into `/openapi.json`, which derives the MCP tool definitions and the
agent toolkit — it is what a calling agent reads at runtime, so it is product surface rather than
developer comfort. Write to an agent: what the operation does and when to reach for it, in English,
not implementation detail. Follow the voice already set by affordance hints.

---

## The two design smells

Both are signals to change the design, not the prose:

1. **If an interface comment cannot be written without describing the implementation, the module is
   shallow.**
2. **If a thing is hard to name, its boundary is wrong.**
