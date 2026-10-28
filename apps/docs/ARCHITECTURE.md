# Customer documentation architecture

`apps/docs` owns public customer and User-owned-agent documentation at `https://docs.fidyapp.com`.
Astro + Starlight produce static Spanish HTML with task-first navigation and Pagefind search.
Marketing/legal documents remain in `apps/site`; authentication and financial authority remain in
the web/API applications. This application has no credentials, product session, database, API
binding, authenticated playground or embedded agent.

## Content and contracts

`src/content/docs` is the maintained content source. Astro's content loader supplies both rendered
HTML and the `.md` endpoint for every published page. `llms.txt` derives from those same entries;
drafts are excluded from all three representations. The Markdown action reads the public `.md`
endpoint and offers an ordinary link when clipboard access is unavailable.

The explicit `docs:reference` command reads the committed server OpenAPI artifact, runtime-decodes
the consumed structure, and selects only `user-owned-agent-scoped` operations. It projects nested
operation alternatives and retains only reachable component schemas. Generated operation pages,
schema documentation and the public OpenAPI subset are committed snapshots. Ordinary builds do
not read server artifacts or regenerate the reference. Guides and examples are manually authored.

Fidy design tokens and bundled Poppins fonts supply branding. Starlight provides navigation,
localized UI, code-copy controls and search. Static styles permit inline style attributes used by
Starlight/Expressive Code, while scripts remain limited to self and exact hashes. Pagefind requires
WebAssembly compilation, so script policy permits `wasm-unsafe-eval`, not arbitrary JavaScript eval.
Starlight's unprocessed inline-script whitespace differs from Astro's collected hashes; the final
build step adds hashes of the actual emitted inline script bytes. Browser acceptance checks verify
search, clipboard, navigation, accessibility and absence of CSP violations.

## Manual publication

`infra/docs` owns a separate `FidyDocs` Alchemy stack and an assets-only `fidy-docs` Worker. The main
product stack never deploys it. The sole publication workflow uses `workflow_dispatch`, protected
trunk and the existing production environment. There is no push or scheduled publication trigger.

The publication build requires an owner-authored Production verification attestation covering all
three documented journeys and the named clients/CLI, bound to the exact static artifact SHA-256.
The attestation is not a live test. Missing, incomplete or mismatched evidence blocks publication.
Alchemy build memoization is disabled so an unchanged build cannot bypass this gate. The Worker
has only `docs.fidyapp.com`, no workers.dev URL, no product bindings, no runtime script and a real 404. Public indexing is enabled only on this gated publication path.

See [manual operations](../../docs/operations/docs-site.md) and the
[implementation checklist/spec](../../docs/operations/docs-site-plan.md).
