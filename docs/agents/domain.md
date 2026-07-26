# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the ubiquitous language.
- **`ARCHITECTURE.md`** at the repo root — this repo keeps its architectural decisions consolidated
  here rather than in a `docs/adr/` directory. Its closing "Decisions and what they rule out" table
  is the equivalent of the ADR record: it names each rejected alternative and why.
- **`CODING_STANDARDS.md`** at the repo root — how code is written inside that architecture.

**Recording a new decision**: add it to the relevant section of `ARCHITECTURE.md` and, if it ruled
something out, add a row to that closing table. Do not create `docs/adr/` — this repo deliberately
consolidated it away.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repo is single-context, with decisions consolidated rather than kept as numbered ADR files:

```
/
├── CONTEXT.md            the ubiquitous language
├── ARCHITECTURE.md       the shape, and a table of rejected alternatives
├── CODING_STANDARDS.md   how code is written inside that shape
└── src/
    ├── core/             pure business rules
    └── shell/            everything that touches the world
```

The `/domain-modeling` skill's default is a `docs/adr/` directory of one file per decision. That was
tried here and consolidated away: seven ADRs covering one coherent architecture read better as one
document with a decisions table than as seven files a reader has to assemble. **Follow this layout,
not the skill's default.**

There is no `CONTEXT-MAP.md` and there should not be — slices are aggregates inside a single bounded
context, not separate contexts. See `ARCHITECTURE.md` §2.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
