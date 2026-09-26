# fidy-ai

fidy-ai has not been released, it is in development phase. Any backward compatibility or anything similar to that is completely unnecessary.

## Agent skills

### Issue tracker

Issues and PRDs live as **GitHub issues** in `B4rz99/fidy-ai`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

**Single-context**: one `CONTEXT.md` at the repo root, with ADRs in `docs/adr/`. See `docs/agents/domain.md`.

## Architecture and conventions

Before writing code, always read:

- **`CONTEXT.md`** — the ubiquitous language. Use these terms; avoid the listed synonyms.
- **`ARCHITECTURE.md`** — the system shape and cross-application boundaries.
- **`CODING_STANDARDS.md`** — code conventions and judgment-based review rules; mechanical checks
  run through `scripts/verify.ts`.
- **`SECURITY_STANDARDS.md`** — the mandatory security review invariants.

Then read the architecture document for every application the change touches:

- **`apps/server/ARCHITECTURE.md`** for server changes.
- **`apps/web/ARCHITECTURE.md`** for web changes.
- **Both application documents** for cross-application changes.

## Source-backed references

For Effect, Alchemy, React, or drag-and-drop work, consult the relevant topic in
[`.patterns/INDEX.md`](.patterns/INDEX.md) before coding. Verify APIs and behavior against its
upstream checkout rather than memory.
