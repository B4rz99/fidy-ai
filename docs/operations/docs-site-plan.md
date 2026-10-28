# Customer documentation implementation

## Agreed brief

Build `docs.fidyapp.com` for customers and their own agents using Astro + Starlight with
Fidy styling. Spanish, current documentation only, task-first navigation. Three journeys:
connect an agent; record/correct Transactions; query finances. MCP first, CLI second,
direct HTTP API advanced. Named client guides initially cover Claude Code and Codex.

One content source supplies HTML, Markdown and `llms.txt`, with search and copy Markdown.
Generate customer-accessible contracts, permissions and declared errors from canonical
artifacts; manually author explanations/examples, permissions and troubleshooting.
Keep contributor material, planned features, an embedded AI assistant and an authenticated
playground outside this site.

The owner chooses when to update, regenerate and publish. No scheduled refreshes, implicit
product-release publication or required documentation updates with product PRs. Publication
is public and indexable only after all three journeys are verified against Production.

## Checklist

- [x] Confirm public test seams and review baseline with the owner.
- [x] Read repository standards, architecture, security policy and selected upstream references.
- [x] Add a separate Starlight application and verify dependency compatibility.
- [x] Implement Spanish task navigation, Fidy styling and responsive accessible layout.
- [x] Add the three journeys, Claude Code/Codex setup, CLI installation and advanced API guidance.
- [x] Explain permissions, approval, expiration, revocation, ambiguity and troubleshooting.
- [x] Add explicit reference generation with only customer-accessible contracts and reachable schemas.
- [x] Publish identical maintained content as HTML, Markdown and `llms.txt`; add copy Markdown.
- [x] Add an independent manual Cloudflare publication path with a Production verification gate.
- [x] Reconcile existing guidance and document the discovery-link handoff at first publication.
- [x] Verify types regularly and run type-aware lint after the first slice and final edit.
- [x] Run focused generation, publication and built-site/browser tests.
- [x] Inspect desktop/mobile rendering, search, clipboard and accessibility.
- [ ] Run Standards, Security and Spec reviews against the starting revision; fix findings.
- [ ] Commit the implementation in the current checkout.

Production activation remains an explicit owner action after real journey evidence is recorded.
Local tests do not establish Production verification.

## Confirmed verification seams

1. Built docs pages, search, Markdown exports and `llms.txt`.
2. The explicit reference-generation command.
3. The manual publication gate.

Initial baseline: `e5073e4ba1b43fdbdf5c1920c59417645b67239c`.
Integration review baseline after synchronizing upstream: `9aa7f42eeb` (the same task diff, excluding unrelated upstream commits).
