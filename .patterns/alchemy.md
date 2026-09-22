# Alchemy v2 Cloudflare topology

Use the vendored `.repos/alchemy` source as the authority for Fidy's Alchemy-managed Cloudflare topology. These notes cover the first static-site, public-Worker, and private-Worker boundary.

## One stack owns the topology

Declare the deployment as one `Alchemy.Stack` with `Cloudflare.providers()`. Use `Cloudflare.state()` for non-development stages, but select `Alchemy.localState()` when `Alchemy.ALCHEMY_DEV` is true so local emulation does not bootstrap remote infrastructure. Yield resources in dependency order and return only useful deployment outputs. The upstream local-development example shows the provider and stack composition (`.repos/alchemy/examples/cloudflare-dev/alchemy.run.ts:155-165`), while Alchemy documents `ALCHEMY_DEV` as the CLI-set development discriminator (`.repos/alchemy/packages/alchemy/src/Phase.ts:33-53`).

Alchemy v2 providers require a configured profile even when every resource is locally emulated. Local tooling may create an isolated placeholder profile only when it also uses local state and local resource modes. CI must create an ephemeral profile from `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; never put production credentials in command arguments or repository files.

Keep Worker entrypoints beside the infrastructure stack when they exist only to realize its runtime boundary. Product domain and canonical operation declarations remain under `apps/`.

## Static applications

`Cloudflare.Website.StaticSite` runs a build command, hashes its output, and deploys the result as a Worker (`.repos/alchemy/packages/alchemy/src/Cloudflare/Website/StaticSite.ts:89-103`). With neither `main` nor `script`, it is an assets-only Worker, so Cloudflare serves the assets and SPA fallback without invoking application code (`.repos/alchemy/packages/alchemy/src/Cloudflare/Website/StaticSite.ts:298-307`).

Use `cwd` for a workspace-owned build and make the build's release inputs explicit environment values. Preserve `_headers` in the output because the assets layer applies it.

## Public and private Workers

A Worker bound in another Worker's `env` is a native service binding. The caller invokes `env.SERVICE.fetch(...)`; the request does not take a public network hop (`.repos/alchemy/examples/cloudflare-dev/alchemy.run.ts:90-98`, `.repos/alchemy/examples/cloudflare-dev/src/AsyncWorker.ts:85-89`).

For a private Worker, set `workersDev: false` and omit `domain` and `routes`. Alchemy documents `workersDev: false` as removing every `workers.dev` URL (`.repos/alchemy/packages/alchemy/src/Cloudflare/Workers/Worker.ts:1917-1923`). Do not attach public storage bindings to an ingress Worker merely because the private Worker can use them.

## Domains and redirects

A Worker's `domain.name` is its canonical custom domain. `domain.redirects` creates permanent edge redirects that preserve path and query and run before Worker code (`.repos/alchemy/packages/alchemy/src/Cloudflare/Workers/Worker.ts:180-221`). Use that mechanism for the apex-to-application redirect rather than adding redirect logic to either application or API Worker.

## Local parity

`alchemy dev` uses local Worker URLs while preserving the declared binding graph (`.repos/alchemy/packages/alchemy/src/Cloudflare/Workers/Worker.ts:1888-1899`). Upstream's CLI test proves a caller Worker reaches its peer through the declared service binding and allows bounded startup propagation (`.repos/alchemy/examples/cloudflare-dev/test/dev.test.ts:181-189`).

Test Fidy's request behavior directly at the Worker fetch seam, then keep one local-emulation acceptance that starts the same stack and proves the public Worker reaches the private Worker. A fake binding can prove projection and failure behavior, but cannot claim service-binding parity.

## Release metadata and exposure

Bind immutable Git revision and contract digest values at deployment. Decode them at the private Worker boundary and construct a closed health response. The public Worker delegates only the intended route and does not expose environment objects, binding names, topology, exception text, or Secrets.
