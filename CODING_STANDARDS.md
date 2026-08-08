# Coding standards

---

## Naming

Bad names cause bugs. **A good name says what the entity is and what it is not.**

- **Precise.** `spentSoFar` beats `total`; `alreadyFired` beats `flags`.
- **Consistent.** One concept, one word, everywhere — the discipline `CONTEXT.md` applies to domain
  terms applies to code.
- **Two or three words.** If a name needs more, it is usually carrying two ideas.
- **If it is hard to name, the design is unclear.** Naming difficulty is a signal about the entity,
  not about vocabulary. Fix the boundary rather than reaching for a longer name.

|                                        |                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| files                                  | kebab-case — `needs-review.ts`                                                                                      |
| schemas, types, classes                | PascalCase                                                                                                          |
| functions, values                      | camelCase                                                                                                           |
| core decisions                         | verb-first — `decideAlerts`, `matchTransaction`, `applyEdit`                                                        |
| repo reads returning `Option`          | `find*` — `findBudget`                                                                                              |
| repo reads where absence is impossible | `get*`                                                                                                              |
| primary Layer on a `Context.Service`   | `static readonly layer` on the service class                                                                        |
| classless production compositions      | `Live` suffix — `PgLive`, `ApiLive`                                                                                 |
| layers assembling a test stack         | named for what they are — `ApiHarness`. `Live` marks the production assembly, so it would read as the opposite here |

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

### Type declarations

Use `type` aliases for first-party object shapes. They are closed declarations and also compose with
unions, tuples, mapped types, and conditional types. Use `interface` only when declaration merging
or module augmentation is deliberately required; never leave a shape open for hypothetical future
extension.

### Tuples

- **Fixed arity — yes.** If there are exactly three of something, do not type it as an array of
  unknown length.
- **Tuple _shape_ — the exception, with a reason.** `readonly [DateTime.Utc, DateTime.Utc]` for a
  range is worse than `{ from, to }`: nothing stops a swap, and the call site reads `range[0]`.
  Tuples earn their place where elements are genuinely positional and unnamed — `Object.entries`
  interop, SQL row shapes, Effect APIs that hand back pairs. Named struct is the default.

### Derived shapes

Build derived shapes from their canonical schemas rather than maintaining parallel definitions.

### Record keyspaces

Judge a `Record` by its actual keyspace and value contract.

- A finite `Record<FailureTag, Status>` is an exhaustive table and strengthens the contract.
- In production code, `Record<string, unknown>` is reserved for genuinely open property bags whose
  keys and values Fidy does not know.
- Do not return `Record<string, unknown>` for a value whose fields are already known. Use the
  canonical schema-derived type or a named first-party shape.

### Other defaults

- `Option` for absence. Never `null`. `undefined` only where an Effect API demands it.
- `ReadonlyArray<T>` in **return** types. Parameters are enforced in core; returns are not.
- `Data.struct` / `Data.tuple` for value objects needing structural equality.
- Effect's own collections (`Chunk`, `HashMap`) only where they earn it. `ReadonlyArray` is the
  default; reaching for `Chunk` on a twenty-element list is cargo cult.
- Local mutation is not banned — a small accumulator inside a pure function is sometimes clearer
  than a fold.

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

First-party `Context.Service` classes own their primary production Layer as `static readonly layer`,
following the Effect v4 convention and keeping construction local to the service. `FooLive` remains
for classless production compositions and configured aliases of third-party Layers.

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

Absence is an `Option` everywhere, and the linter enforces it. Two rules nothing can check:

- **`orDie` is for defects only.** A dead connection, yes. "Budget not found", no — that is a typed
  error that must reach the API response.
- **The handler decides what an absent row means.** The repo cannot know whether a missing budget is
  a 404, an upsert, or simply an empty answer. Use `findOneOption` for `SELECT … WHERE`; `findOne`
  only where absence is genuinely impossible, such as `INSERT … RETURNING`, where it is a defect and
  dying is right.

---

## Tests

What review looks for:

- **Descriptions are behaviour sentences**, not method names: _"rejects exponent notation before
  storing Money"_ or _"rejects more fractional digits than the Currency permits"_, not
  _"Money validation"_.
- **Exercise the public interface.** Never mock an internal collaborator. Pure exported policy
  checkpoints may be tested directly, but their integration still needs API-seam coverage.
- **Fixtures are builders with sensible defaults**, overridden per test with only the fields that
  matter, so a reader sees immediately what the test is about.
- **Prefer a derived guard over a hand-kept list** wherever the assembled API can supply the
  operation set; use exhaustive typed probes when each operation needs explicit behavior.
- **Vitest `expect` is the default for ordinary values.** Its Effect equality testers are a no-op in
  the current beta, so use `Equal.equals` for `BigDecimal` and hashed collections. When a tagged
  error class is part of the contract, compare the whole `Exit` with `assert.deepStrictEqual` so a
  structurally identical instance of the wrong class cannot pass.

---

## React

React application code is event-driven and keeps only irreducible interaction state.

- **`useEffect` is banned.** Derive presentation during render and perform commands in the event
  handler that caused them. A state transition must never serve as an indirect command.
- Server state belongs to TanStack Query, navigation state to TanStack Router, and external-store
  subscriptions to `useSyncExternalStore`.
- Do not store values that can be derived from props, query data, router state, or existing local
  state. Reset interaction state through component identity and `key` where appropriate.
- If a concrete imperative integration eventually requires React synchronization, isolate it behind
  one narrow adapter and add an explicit file-scoped lint override. Do not add speculative
  exceptions or expose the synchronization mechanism to application components.

---

## Agent-facing documentation

Presence is enforced; **voice is not**, and voice is what makes it useful.

`OpenApi.Description` flows into `/openapi.json`, which derives the MCP tool definitions and the
agent toolkit — it is what a calling agent reads at runtime, so it is product surface rather than
developer comfort. Write to an agent: what the operation does and when to reach for it, in English,
not implementation detail. Follow the voice already set by suggested operation hints.

Construct SuggestedOperations with `suggestOperation`; checkpoint every non-empty `next` by caller
scope and tier. Hints are one English sentence of at most 140 characters.

---

## The two design smells

Both are signals to change the design, not the prose:

1. **If an interface comment cannot be written without describing the implementation, the module is
   shallow.**
2. **If a thing is hard to name, its boundary is wrong.**
