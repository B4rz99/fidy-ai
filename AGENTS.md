# fidy-ai

## Agent skills

### Issue tracker

Issues and PRDs live as **GitHub issues** in `B4rz99/fidy-ai`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

**Single-context**: one `CONTEXT.md` at the repo root, with architectural decisions consolidated
into `ARCHITECTURE.md`. See `docs/agents/domain.md`.

## Architecture and conventions

Read all three before writing code:

- **`CONTEXT.md`** — the ubiquitous language. Use these terms; avoid the listed synonyms.
- **`ARCHITECTURE.md`** — the shape and why. Its closing table records the rejected alternatives;
  read it before proposing a change, because most obvious alternatives were considered and turned
  down for reasons not visible in the code.
- **`CODING_STANDARDS.md`** — how code is written inside that shape. Its two closing sections are
  the ones to check against: what is mechanically enforced, and what is review-only.

## Effect reference

A full checkout of the [Effect](https://effect.website) source lives at `.repos/effect`. This project is built on Effect, so use that checkout as the source of truth: read it to extract best practices, understand how APIs and internals actually work, check idiomatic usage, and verify behavior against the real implementation rather than guessing. Prefer it over memory when working with Effect.

### Patterns

Distilled research on how Effect actually works, extracted from the `.repos/effect` source (citations are `path:line` into that checkout). Read the relevant file before working in its area; add a new file here when researching an Effect area not yet covered.

- `.patterns/http-api.md` — `effect/unstable/httpapi`: contracts-once derivation (server / typed client / OpenAPI), request/response validation semantics, error modeling, schema patterns for contracts, testing seams, middleware.
