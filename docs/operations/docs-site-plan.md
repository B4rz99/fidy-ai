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

The owner chooses when to update content and regenerate references. Publication runs automatically
when docs or their build inputs change on trunk. There are no scheduled refreshes or required docs
updates with product PRs. The three journeys must pass against Production before first publication.

## Checklist

- [x] Confirm public test seams and review baseline with the owner.
- [x] Read repository standards, architecture, security policy and selected upstream references.
- [x] Add a separate Starlight application and verify dependency compatibility.
- [x] Implement Spanish task navigation, Fidy styling and responsive accessible layout.
- [x] Add the three journeys, Claude Code/Codex setup, CLI installation and advanced API guidance.
- [x] Explain permissions, approval, expiration, revocation, ambiguity and troubleshooting.
- [x] Add explicit reference generation with only customer-accessible contracts and reachable schemas.
- [x] Publish identical maintained content as HTML, Markdown and `llms.txt`; add copy Markdown.
- [x] Add an independent automatic Cloudflare publication path with docs checks before deployment.
- [x] Reconcile existing guidance and document the discovery-link handoff at first publication.
- [x] Verify types regularly and run type-aware lint after the first slice and final edit.
- [x] Run focused generation, publication and built-site/browser tests.
- [x] Inspect desktop/mobile rendering, search, clipboard and accessibility.
- [x] Run Standards, Security and Spec reviews against the starting revision; fix findings.
- [x] Commit the implementation in the current checkout.

The first automatic deployment follows real Production journey verification.
Local tests do not establish Production verification.

## Confirmed verification seams

1. Built docs pages, search, Markdown exports and `llms.txt`.
2. The explicit reference-generation command.
3. The publication workflow and its checks.

Initial baseline: `e5073e4ba1b43fdbdf5c1920c59417645b67239c`.
Integration review baseline after synchronizing upstream: `9aa7f42eeb` (the same task diff, excluding unrelated upstream commits).

## Verification result

The original implementation review reported no Standards, Security or Spec findings. Its focused docs tests
passed; the existing verification
runner's four focused tests also pass. Full typecheck, lint, type-aware lint, formatting, dependency
policy and pattern-source checks passed. Desktop/mobile rendering was inspected. Repeat builds of
unchanged sources produced the same publication digest.

## Automatic publication follow-up

- [ ] Verify all three journeys against Production with the documented clients and CLI.
- [x] Replace manual attestation/dispatch with automatic publication on trunk changes.
- [ ] Record Production verification outcomes and merge the automatic deployment change.
- [ ] Verify the public site and point marketing discovery to the now-served docs hostname.
