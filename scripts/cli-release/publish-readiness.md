# CLI distribution evidence gate

The checked-in `publish-readiness.json` records independently reviewed source-bound
materials. It does not establish signing or public availability, and it is not a
legal-compliance guarantee. The runtime/application inventory, full notices,
scoped CLI permission and accompanying source route were reviewed together.
Source or material changes invalidate that binding. Synthetic test fixtures
cannot substitute for the reviewed distribution evidence.

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
- `validate --version 0.1.0 --expected-sha SHA --artifacts PATH --source-artifact SOURCE_PATH`: validate the
  same source/context and all ten assets without network or candidate execution.
- `publish --version 0.1.0 --expected-sha SHA --artifacts PATH --source-artifact SOURCE_PATH`: repeat validation
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
  in the manifest must be true following that review
- `materials`: the five named entries in the template, each an object containing
  a repository-relative tracked `path` and exact lowercase `sha256`

The five files must be distinct, nonempty regular tracked files. Material hashes,
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
- `evidence`: an empty array for `none`/`not_required`; for a required source
  obligation, one or more reviewed same-release source-asset records as below

Every required-source evidence record has exactly:

- `source_asset`: `fidy-cli-v0.1.0-source.tar.gz`
- `source_spec_sha256`: the exact SHA-256 commitment to the generated canonical source specification
- `path_prefixes`: one to 100 unique canonical, nonempty directory prefixes,
  each ending in `/`, at most 256 UTF-8 bytes, and matching at least one actual
  file in that trusted specification

Unknown, unresolved, missing or duplicate decisions fail closed. Required source
cannot be established by an external URL/digest assertion. The prefix decisions
must be reviewed as complete coverage of the component's obligations, including
necessary modifications, interfaces and compilation/install data. Before publication, the validator
checks that every claimed prefix identifies reviewed content; it does not infer
legal completeness from a prefix match.

This binds readiness to the selected source bytes independently of the eventual
merge commit. Do not store the final source archive's SHA-256 in tracked evidence:
`SOURCE-RELEASE.json` contains that future source commit, so doing so would create
a circular commit/archive binding. The publisher validates every source member
against the trusted spec, checks the generated exact-commit metadata and archive
sidecar, then verifies anonymous delivery of the complete same-release archive.
If obligations need additional assets or a different layout, review that contract
before approving rather than replacing these checks with a boolean or URL claim.

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

## Reviewed source archive

Readiness's fifth material, `source_plan`, is a compact tracked recipe with its
own exact SHA-256. It pins the eight upstream repository revisions, reviewed
source selections and symlink omissions, application input paths, local recipe
files and application payload digest. Its `manifest_sha256` is the reviewed
commitment to the generated full specification. The recipe and its commitment
are not members of that specification, avoiding a self-reference.

The two large per-file indexes are generated in the read-only source job rather
than checked into Git. The generated `source-spec.json` has `schema_version: 1`,
`cli_version: "0.1.0"`, the full `bun_revision`, and sorted `files`. Each file
record has `path`, `mode` (420 or 493), `bytes` (including trusted empty files),
lowercase `sha256`, and `origin`. Generation must reproduce the reviewed
commitment exactly; a changed input or selection requires a reviewed update.

The only origin shapes are:

- Git: `kind: "git"`, `repository: "owner/repo"`, exact 40-character `revision`,
  original `path`, and `git_blob_sha1`
- Checkout: `kind: "checkout"`, original tracked `path`, and `git_blob_sha1`
- Application payload: exactly `kind: "generated"`, `generator: "bun-build"`,
  and `label: "application-payload"`
- Recipient index: exactly `kind: "generated"`, `generator: "source-index"`,
  and `label: "recipient-index"`

The dedicated read-only source job acquires only reviewed immutable official Git
objects, verifies every selected byte and origin, and builds the application
payload with the pinned runtime/frozen workspace. It compares its input closure
with the reviewed source selection. Two assemblies reuse a bounded cache but
revalidate every input and must produce identical archive and sidecar bytes.
Neither ordinary PR smoke fixtures nor prior run artifacts enter this path.
The assembler is separate from the privileged publisher.

The archive adds exactly one dynamic member, `SOURCE-RELEASE.json`, whose bytes
are computed from the trusted version, runtime revision and exact dispatched
source SHA. Its fields are `schema_version`, `cli_version`, `bun_revision` and
`source_commit`, serialized with sorted keys, two-space indentation and a final
newline. The spec cannot supply or override this member. A static source index
may describe all other source inputs but must not embed its own digest or this
dynamic member's digest.

The publisher first hashes the downloaded specification and compares it with
the commitment in the trusted checked-out recipe, before parsing its contents.
Only then does it compare every raw USTAR header and source-member digest,
including Git blob SHA-1 identities, and check the required source prefixes.
An artifact's self-declared inventory cannot authorize its contents. The publisher
never fetches source, extracts files or executes source/archive bytes.

Exact format and limits:

- One gzip member with bytes `1f8b08000000000002ff` as its header: no optional
  name/comment fields, mtime zero, maximum-compression XFL and OS 255
- Sorted canonical UTF-8 relative USTAR regular-file entries; reviewed mode 0644
  or 0755; uid/gid/mtime zero; empty owner/group names and link target
- No directory/link/device/sparse/PAX/GNU records, traversal, duplicate or
  case-fold/file-prefix collisions, reserved recipient filenames or aliases
- Zero-filled entry padding; exactly two final zero 512-byte blocks; no extra
  tar padding, trailing bytes or concatenated gzip members
- At most 8 MiB of specification JSON, 128 MiB compressed archive bytes,
  16 MiB per file, 512 MiB for the entire decompressed tar stream, and 20,000
  total regular entries including dynamic release metadata

The separate `cli-source` Actions artifact contains exactly
`fidy-cli-v0.1.0-source.tar.gz`, `fidy-cli-v0.1.0-source.tar.gz.sha256`, and
`source-spec.json`. The generated specification is internal validation evidence,
not an extra public release asset. The publisher takes its directory through `--source-artifact`; the existing
native artifact root still contains exactly three native directories. All ten
validated assets must upload successfully before publication, and all ten exact
byte sequences must be anonymously available before success is reported.
Missing source or failed source download is a failed release, even when a public
release may already exist. The native ZIPs still contain exactly three entries,
and installers neither fetch nor execute the source packet.

`publish-source.py` exposes `spec_decode(data, version, bun_revision)`,
`source_metadata(version, bun_revision, source_commit)`,
`canonical_header(record)`, and `validate_artifact(directory, raw_spec,
cli_version=..., bun_revision=..., source_commit=...)` for the reviewed assembler
and publisher. These functions do not grant readiness or interpret source/license
completeness; the reviewed inventory, notices, source/grant/recipe content,
first-party authority and full source binding remain required.
