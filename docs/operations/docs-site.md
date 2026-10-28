# Maintain and publish customer docs

The owner decides when to edit, refresh and publish `docs.fidyapp.com`. Product releases do not
update this independently owned site. There is no scheduled refresh, automatic reference generation
or rule requiring product PRs to update documentation.

## Edit and preview

Use the repository's pinned Bun runtime and locked workspace install. Run:

```sh
bun run dev:docs
```

The local site is served on port 4323. Edit `apps/docs/src/content/docs`; keep explanations and
examples in Spanish, and exact operation/field names unchanged. Keep planned features and
contributor instructions outside the site. The three primary tasks are connecting an agent,
recording/correcting Transactions, and querying finances.

To explicitly refresh the generated reference from the committed canonical server artifact:

```sh
bun run docs:reference
```

Review the generated diff, including permissions, confirmation requirements, errors and reachable
schemas. This command does not fetch Production or certify that a capability is deployed. Do not
publish new operations until their customer workflows work against Production. Ordinary docs
builds keep the committed reference snapshot unchanged.

## Verify the candidate

```sh
bun run docs:build
bun run docs:test
bun run --cwd apps/docs typecheck
bun run --cwd infra/docs typecheck
bun run --cwd apps/docs test:browser
bun run docs:publication:inspect
```

Install Playwright Chromium if it is not already available. The inspect command prints the exact
built artifact's SHA-256. It never approves publication. Rebuild after an edit and inspect again.
Local browser tests cover static content, Markdown, search, copying, mobile navigation and
accessibility. They do not verify authenticated Production journeys.

## Record Production journey evidence

Using a dedicated authorized Production test account, follow the actual published instructions:

1. Connect Claude Code and Codex through MCP, approve the intended scopes/lifetime, discover tools
   and query a Transaction. Record exact client versions and the serving Production revision.
2. With each documented client path, create a synthetic Transaction, identify it, correct that same
   record with its current revision and complete the required approval. Query it again to verify
   the result. Confirm that declining approval does not make the change. Clean up test records
   through supported product controls.
3. Query finances with the documented currency, date interval and pagination. Verify the returned
   records and separate currencies. Repeat the documented CLI connection, capture/correction and
   query alternatives; record its executable version.

Do not use a personal customer's financial records or copy credentials, financial content or
one-time approval links into evidence. Record what was checked, its result and a non-secret
reference to the verification record. If any journey fails, repair the instructions/product and
repeat the affected verification before publishing.

Prepare an owner attestation JSON outside the public content tree:

```json
{
  "artifactDigest": "<SHA-256 printed by docs:publication:inspect>",
  "productionRevision": "<40-character serving Production Git revision>",
  "verifiedAt": "<UTC instant, such as 2026-10-27T20:00:00.000Z>",
  "clients": {
    "claudeCode": "<verified version>",
    "codex": "<verified version>",
    "cli": "<verified version>"
  },
  "journeys": { "connect": true, "recordCorrect": true, "query": true },
  "evidence": "<what was checked, outcomes and non-secret verification-record reference>"
}
```

These markers are intentionally invalid. The publication checker validates shape and artifact
identity; the owner is responsible for the truth of the recorded Production verification. It does
not contact the API or execute these workflows. Never mark a local/synthetic test as Production.

## Publish explicitly

Use **Publish customer docs** in GitHub Actions, select protected `trunk` and supply the complete
attestation JSON as the `verification` input. The workflow builds and validates the artifact, runs
focused checks and deploys only the separate docs stack through Alchemy. A digest mismatch blocks
publication; it never updates the evidence or reference silently. The Cloudflare credentials and
production environment are the existing protected repository configuration.

For an explicitly authorized local publication using the configured Alchemy profile:

```sh
DOCS_VERIFICATION_FILE=/absolute/path/to/verification.json bun run --cwd infra/docs publish
```

The static site is public and indexable after this gated publication. Verify the live Markdown,
`llms.txt`, reference, search and three journeys. Then point marketing navigation and its `llms.txt`
to the authoritative docs; do not advertise an unserved hostname before first publication.

To republish an older known-good docs snapshot, explicitly select that source revision, rebuild,
review its compatibility with the current product, record matching verification and publish it.
The site exposes only the selected current docs, without a version archive.
