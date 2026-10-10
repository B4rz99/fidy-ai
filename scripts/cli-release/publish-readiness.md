# CLI distribution evidence gate

The checked-in `publish-readiness.json` is deliberately **blocked**. It does not
establish a first-party license, a complete bundled-runtime/dependency inventory,
complete notices, satisfied source obligations, signing, or public availability.
No real legal materials are supplied by this change. Do not substitute the
synthetic test fixtures for reviewed distribution evidence.

`publish.py` uses Python's standard library and the checked-out Git repository.
The privileged job does not install dependencies, run a build, or execute a
candidate binary or installer. Its public commands are:

- `prepare`: print the committed source-tree digest for a later human review.
  This does not change the manifest or approve anything.
- `materials --version 0.1.0 --destination PATH`: validate reviewed source and
  material, then write only `BUN-LICENSE.txt` and `THIRD-PARTY-NOTICES.txt`. It
  requires no GitHub context, token or network. The builder calls this before
  compilation, so incomplete material cannot become a release candidate.
- `preflight --version 0.1.0 --expected-sha SHA`: require an approved manifest,
  clean exact source, a first-attempt trunk dispatch, public repository visibility,
  current trunk, and no visible existing version release/tag. Read-only tokens
  may not see drafts; the publisher repeats the check with its write-scoped token.
- `validate --version 0.1.0 --expected-sha SHA --artifacts PATH`: validate the
  same source/context and all eight assets without network or candidate execution.
- `publish --version 0.1.0 --expected-sha SHA --artifacts PATH`: repeat validation
  and remote preflight, recheck trunk, create one draft, upload each asset once,
  verify the complete draft, recheck trunk and publish. Finally verify the tag
  target and exact anonymous download bytes, including installers. Every mutation
  has one attempt. It never updates an existing version, deletes partial state,
  retries an uncertain write, or sets this release as the repository's latest.

Only the last command changes GitHub. A failed post-publication verification does
not roll back publication. A draft, tag, assets or public release may already
exist. Inspect GitHub manually; do not rerun or overwrite assets. A fresh dispatch
will reject an existing version. Workflow reruns are refused to prevent using
candidate artifacts retained from an earlier run attempt.

## Reviewed manifest

An approval requires a separate reviewed change to the manifest and actual
material. All eight top-level fields in the committed JSON must remain present:

- `schema_version`: integer `1`
- `version`: exact numeric `0.1.0`
- `status`: `approved` only after the evidence below has been reviewed
- `runtime_revision`: `13a98b0dbd136bcc5c98a8adfb53c909aa3183cc`
- `source_tree_sha256`: the digest printed by `prepare`
- `review_reference`: a specific `https://github.com/B4rz99/fidy-ai/pull/NUMBER`
  or `/issues/NUMBER` review, optionally anchored to a comment
- `attestations`: every named distribution/inventory/notices/source assertion
  in the blocked template must be true following that review
- `materials`: the four named entries in the template, each an object containing
  a repository-relative tracked `path` and exact lowercase `sha256`

The four files must be distinct, nonempty regular tracked files. Material hashes,
source identity, all component decisions and packaged notice bytes are checked;
bare affirmative attestations are insufficient. The inventory and source-decision
files have the structured contracts below. The two notice files are actual,
reviewed UTF-8 legal material, not summaries or invented license grants.

The tree digest is SHA-256 over sorted, NUL-separated complete entries returned by
`git ls-tree -rz --full-tree HEAD`, with a final NUL, excluding only the manifest's
entry. Entries retain Git mode, object type, object ID and path. Consequently,
source, tooling, lockfile or evidence changes invalidate the review. Commit the
reviewed source/material first, run `prepare`, then commit only the completed
manifest. A manifest-only commit avoids a self-hash problem. `prepare` reports
committed HEAD, not uncommitted edits. Material preparation/publication rejects
tracked working-tree changes.

## Inventory JSON

Required top-level fields: `schema_version: 1`, `status: "reviewed_complete"`,
`version: "0.1.0"`, the exact `runtime_revision`, and nonempty `components`.
Inventory the actual compiled distribution, including Bun's embedded components
and bundled application dependencies. The publisher does not infer this inventory
from a package manifest or claim to determine legal completeness automatically.

Each component has exactly these nonempty text fields:

- `id`: unique stable inventory identity
- `kind`: `first_party`, `runtime`, `runtime_dependency` or `bundled_dependency`
- `version`: the exact reviewed component version/revision
- `license`: the reviewed distribution terms or applicable license identifiers
- `source`: its reviewed HTTPS source URL
- `notice`: the reviewed notice decision and where required text is retained
- `status`: `reviewed`

All four component classes are required. Unknown, unresolved or duplicate
component decisions block publication. The review must substantiate first-party
distribution authority; this workflow neither chooses nor grants a license.

## Source-obligation JSON

Required top-level fields: `schema_version: 1`, `status: "complete"`,
`inventory_sha256` matching the exact inventory file, and `components` with
exactly one decision for every inventory component. Each decision has exactly:

- `id`: the inventory component identity
- `requirement`: `none` or `source_required`
- `status`: respectively `not_required` or `fulfilled`
- `basis`: a substantive reviewed explanation of the decision
- `evidence`: an array of preserved source-distribution records, each containing
  the actual public HTTPS `url` and exact lowercase `sha256` of the source bytes

A `source_required` decision requires at least one evidence record. Unknown,
unresolved, missing or duplicate decisions fail closed. The reviewer must verify
that referenced source is the corresponding version, is actually preserved and
available to recipients, and satisfies applicable source/offer obligations. URLs
and hashes record that reviewed evidence; the publisher does not independently
interpret license obligations or treat a link alone as proof. If obligations need
additional release assets or a different distribution layout, change and review
that contract before approving; do not force them into the eight-asset gate.

## Same-run artifact contract

The downloaded root must contain exactly these directories, without merging:

- `cli-candidate-Linux-X64`: `fidy-linux-x64.zip` and `.zip.sha256`
- `cli-candidate-macOS-ARM64`: `fidy-darwin-arm64.zip` and `.zip.sha256`
- `cli-candidate-Windows-X64`: `fidy-windows-x64.zip` and `.zip.sha256`

Every directory also contains `install.sh` and `install.ps1`, byte-identical to
the exact trusted checkout. Each ZIP contains exactly the platform executable
(`fidy`, or `fidy.exe` on Windows), `BUN-LICENSE.txt` and
`THIRD-PARTY-NOTICES.txt`. Entries are regular, unencrypted, stored files with
executable mode `0755` and notice mode `0644`; notices equal reviewed material.
Binary headers must match the native platform. The read-only native jobs own
execution/version/help and repeat-build checks. This publisher never executes
those bytes under its write-scoped token.

See GitHub's [reusable workflow contract](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
[release API](https://docs.github.com/en/rest/releases/releases), and
[asset API](https://docs.github.com/en/rest/releases/assets). Existing tags override
`target_commitish`; failed uploads can leave starter assets. Those behaviors are
why this workflow refuses existing versions and never retries mutations.
