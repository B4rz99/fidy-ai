# Alchemy v2 Cloudflare topology

API authority is installed `alchemy@2.0.0-beta.80`, including Fidy's retained patch, not the older
`.repos/alchemy` snapshot. Selected sources under `node_modules/alchemy/src/` are `Phase.ts`,
`Stack.ts`, `Cloudflare/Website/StaticSite.ts`, and `Cloudflare/Workers/{Worker,WorkerProvider}.ts`.
Fidy's composition is `infra/cloudflare/alchemy.run.ts`; see [the source map](effect-4-stable.md)
for CLI and WorkerProvider patch behavior.

## One stack, explicit state authority

One `Alchemy.Stack` with `Cloudflare.providers()` owns the deployment. Fidy selects
`Cloudflare.state()` only for supported Production deployment, `Alchemy.localState()` for
`ALCHEMY_DEV`, and in-memory state during provider discovery or unsupported-stage rejection.
Invalid stages must be rejected before they contact remote state.

Alchemy's CLI sets `ALCHEMY_DEV`; a configured profile is still required for local emulation.
A placeholder profile is safe only with local state and local resource modes. CI uses an ephemeral
profile from environment credentials; credentials stay out of command arguments and repository files.
Bootstrap the provider's remote state before the first plan, and pass explicit approval for
non-interactive deployment. Scope `AdoptPolicy.adopt(true)` to a known existing resource, not the stack.

## Assets and Worker exposure

`Cloudflare.Website.StaticSite` builds and hashes assets. Without `main` or `script`, it deploys an
assets-only Worker. Use `cwd` for the owning workspace and explicit release inputs for its build.
Preserve `_headers`; the assets layer applies it independently of application code.

A Worker value in another Worker's `env` declares a native service binding. Fidy's public ingress
calls private Core through that binding; public ingress does not receive Core's storage bindings.
For private Core, use `workersDev: false` with no public domain/routes. This disables both stable
and preview `workers.dev` URLs, not just the primary URL.

`domain.name` declares the canonical hostname; `domain.redirects` creates permanent edge redirects
preserving path and query. Redirect hostnames do not appear in `worker.urls`. Under local development,
`worker.urls` contains local server addresses instead of production URLs.

## Runtime and deployment evidence

Invoke beta.80 via `node_modules/alchemy/bin/alchemy.js` with the pinned Bun, as existing scripts do.
The package's `bin/cli.js` wrapper applies a package TS configuration that loses Fidy's aliases.
Use the existing entrypoint rather than adding another loader or runtime fallback.

The patch `patches/alchemy@2.0.0-beta.80.patch` preserves and verifies the uploaded Worker version
receipt using `getScriptVersion`. An upload receipt is not proof of active traffic assignment;
retain the deployment/version checks at their existing owners.

Local acceptance starts the declared stack and exercises ingress-to-Core service bindings. A fake
binding proves projection/failure behavior only, not platform parity. Bind validated immutable Git
revision and contract digest values, and expose only the closed health projection—never environment
objects, topology, Secrets, or raw exceptions.
