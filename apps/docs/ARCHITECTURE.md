# Customer documentation architecture

`apps/docs` owns public customer and User-owned-agent documentation at `https://docs.fidyapp.com`.
Astro + Starlight produce static Spanish HTML with task-first navigation and Pagefind search.
Marketing/legal documents remain in `apps/site`; authentication and financial authority remain in
the web/API applications. This application has no credentials, product session, database, API
binding, authenticated playground or embedded agent.

## Content and contracts

`src/content/docs` is the maintained content source. Astro's content loader supplies both rendered
HTML and the `.md` endpoint for every published page. `llms.txt` derives from those same entries;
drafts are excluded from all three representations. Type-aware lint explicitly runs `astro sync` before loading the docs collection types, so a fresh
checkout does not depend on another parallel check generating them first. The repository graph
recognizes `astro:content` as a framework-provided virtual module only inside docs source; other
unresolved imports still fail. The Markdown action reads the public `.md`
endpoint and offers an ordinary link when clipboard access is unavailable.

The explicit `docs:reference` command reads the committed server OpenAPI artifact, runtime-decodes
the consumed structure, and selects only `user-owned-agent-scoped` operations. It projects nested
operation alternatives and retains only reachable component schemas. Generated operation pages,
schema documentation and the public OpenAPI subset are committed snapshots. Ordinary builds do
not read server artifacts or regenerate the reference. Guides and examples are manually authored.

Fidy design tokens, the product logo and bundled Poppins/DejaVu Sans Mono fonts supply branding.
Fidy components own the responsive documentation shell, grouped navigation, contextual Markdown
actions and theme controls. Starlight owns the static content pipeline and code-copy controls;
Pagefind supplies same-origin search. Search results activate only known maintained document routes.
Structured operation and schema views decode the committed public OpenAPI subset at build time;
they retain complete JSON and leave the maintained Markdown exports unchanged. Static styles permit inline style attributes used by
Starlight/Expressive Code, while scripts remain limited to self and exact hashes. Pagefind requires
WebAssembly compilation, so script policy permits `wasm-unsafe-eval`, not arbitrary JavaScript eval.
Starlight's unprocessed inline-script whitespace differs from Astro's collected hashes; the final
build step adds hashes of the actual emitted inline script bytes. Browser acceptance checks verify
search, clipboard, navigation, accessibility and absence of CSP violations.

## Automatic publication

`infra/docs` owns a separate `FidyDocs` Alchemy stack and an assets-only `fidy-docs` Worker. The main
product stack never deploys it. The publication workflow runs automatically on changes to docs,
their infrastructure or shared build inputs on protected trunk, using the existing production
environment. It checks out the triggering revision, builds the site, verifies types and runs the
artifact, reference and browser checks before deploying. There is no owner attestation input,
manual dispatch or scheduled refresh.

The three documented journeys must be verified against Production before the first publication.
Local docs tests do not establish authenticated Production verification. After initial verification,
merging a documentation change publishes it automatically; reference regeneration remains explicit.
Alchemy build memoization is disabled. The Worker
has only `docs.fidyapp.com`, no workers.dev URL, no product bindings, no runtime script and a real 404.
The workflow verifies the served Markdown and agent index against the built artifact after deployment.

See [publication operations](../../docs/operations/docs-site.md) and the
[implementation checklist/spec](../../docs/operations/docs-site-plan.md).
