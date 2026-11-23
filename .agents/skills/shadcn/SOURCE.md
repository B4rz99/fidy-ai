# Upstream source

Installed with the official `skills` installer from `shadcn/ui`, skill path
`skills/shadcn`, at upstream commit `a85299a9edd2a961e32f01ced86963a852652bd2`.

This repository adapts the upstream instructions to its pinned `shadcn` 4.23.0
dependency: every CLI invocation names that exact version, and the checked-in
`skills-lock.json` records a deterministic tree hash of the adapted files. The
hash covers every file in this directory, sorted by repository-relative path,
as SHA-256 over `path`, a NUL byte, the file bytes, and a trailing NUL byte.
`LICENSE.md` and this provenance note are repository-added packaging files.

`bun run check:skills` verifies the tree hash, requires this note, and rejects
any `shadcn@latest` invocation.
