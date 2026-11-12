# Customer documentation architecture

`apps/docs` owns public customer and User-owned-agent documentation at `docs.fidyapp.com`.
Astro and Starlight produce static Spanish documentation with Pagefind search. Read the repository
[architecture](../../ARCHITECTURE.md) for application boundaries.

## Content ownership

Maintained content in `src/content/docs` supplies rendered HTML, Markdown exports and agent discovery.
Guides are authored directly. API reference pages and the public OpenAPI subset are committed
snapshots derived from server declarations; reference generation is explicit and separate from an
ordinary site build.

Starlight owns the content pipeline, Fidy components supply branding and navigation, and Pagefind
provides same-origin search. This application has no product session, credentials, database or
authenticated API binding. Marketing and legal content remain with `apps/site`; product authority
remains with the web and server applications.

## Publication boundary

A separate Alchemy stack in `infra/docs` deploys an assets-only Worker independently of the product
stack. Changes to documentation or its build inputs on protected trunk publish automatically after
build and artifact checks. The site serves the committed reference snapshot without discovering
operations at runtime.

See [publication operations](../../docs/operations/docs-site.md) for verification and deployment
procedures, and [contract artifacts](../../docs/server-contract-artifacts.md) for the server source.
