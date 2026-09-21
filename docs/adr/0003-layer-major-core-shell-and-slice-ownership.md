# Layer-major core and shell with slice-owned data

- **Status:** Accepted
- **Date:** 2026-08-01

## Context

fidy needs a compiler-visible boundary between business decisions and side effects. It also needs
aggregate boundaries that preserve atomicity and keep each invariant owned by one place. A
slice-major layout and filename conventions make those properties easy to violate accidentally,
especially when independent agent sessions add code.

A slice is not an API group or a bounded context. fidy is one bounded context, and API groupings
are presentation choices. A slice owns the data whose invariants it enforces; a process that
coordinates data owned by several slices belongs in the shell.

## Decision

Use a layer-major source tree:

- `src/core/` contains pure business decisions typed `Effect<A, E, never>`.
- `src/shell/` contains repositories, handlers, adapters, API assembly, and other effects.
- `src/client.ts` is the browser-safe declaration seam; Cloudflare adapters compose production
  entrypoints outside this package.
- A slice's core files and shell files live in their respective trees; the directory boundary is
  the purity boundary.
- `api.ts` assembles operation definitions. Cloudflare adapters consume the assembled API and
  compose the platform bindings without importing core implementation details.

Use the rule **“a slice owns data; a process coordinates slices.”** A process that touches one
slice's data lives inside that slice. A process that owns data nobody else owns is a slice. A
process that owns no data is shell-only. A process never writes another slice's tables; it calls
the owning slice's operations.

Slices are drawn using three checks:

1. Data that must commit atomically belongs to one slice unless an accepted coordination decision
   explicitly composes owner operations: canonical state plus Audit evidence in ADR 0005 and legal
   bootstrap in ADR 0009. Cloudflare adapters provide the atomic and coordination boundaries.
2. Cross-slice references use stable ids, not embedded objects.
3. An invariant that must hold immediately is enforceable inside one slice.

Core slices may share ownerless values from `core/_shared` or a sibling's narrow `reference.ts`.
They may not import another slice's model, rules, errors, taxonomy, or implementation. Shell code
loads and coordinates data for cross-slice decisions.

## Consequences

The directory and dependency graph make the core boundary enforceable by lint and dependency
checks. New work has a predictable home, and a process cannot silently bypass another slice's
invariants by writing its tables directly.

One feature may touch both trees, and shell signatures can be wider because the shell explicitly
assembles inputs. That cost is accepted in exchange for a boundary that survives refactoring and
independent agent sessions.

`api`, `channels`, and `agent` are shell-only areas because they own no domain aggregate.

## Rejected alternatives

### Slice-major layout

Rejected because the purity boundary becomes a filename convention and a file can sit in an
ambiguous place.

### Slice equals API group

Rejected because API groups are presentation and can be regrouped without changing data
ownership or invariants.

### Free cross-slice core imports

Rejected because a core slice would begin gathering or deciding over another slice's data instead
of receiving plain values from the shell.
