# Maintain and publish customer docs

`docs.fidyapp.com` publishes automatically when docs or their build inputs change on protected
`trunk`. The owner still chooses when to edit content and regenerate references. Product PRs do
not have to update docs, and there is no scheduled content refresh.

## Edit and preview

Use the repository's pinned Bun runtime and locked workspace install:

```sh
bun run dev:docs
```

The local site is served on port 4323. Edit `apps/docs/src/content/docs`; keep explanations and
examples in Spanish, and exact operation/field names unchanged. Keep planned features and
contributor instructions outside the site. The three primary tasks are connecting an agent,
recording/correcting Transactions, and querying finances.

To refresh the generated reference from the committed canonical server artifact:

```sh
bun run docs:reference
```

Review the generated permissions, confirmation requirements, errors and reachable schemas. This
explicit command does not fetch Production or certify that a capability is deployed. Ordinary
builds keep the committed snapshot unchanged. Document only working Production capabilities.

## Verify changes

```sh
bun run docs:verify
bun run --cwd apps/docs typecheck
bun run --cwd infra/docs typecheck
```

Install Playwright Chromium if needed. These checks cover the built content and Markdown,
reference filtering, search, copying, mobile navigation, accessibility and CSP. They do not
establish authenticated Production journey verification.

## Verify the Production journeys

Before first publication, use a dedicated authorized synthetic Production User, or an account
whose owner explicitly authorizes the marked test workflow, and follow the actual instructions.
Record serving API/web revisions, client versions, UTC time and outcomes:

1. Connect Claude Code and Codex through MCP, approve the intended scopes/lifetime, discover tools
   and query a Transaction.
2. Create a synthetic Transaction, identify it, correct that same record with its current revision
   and complete native approval. Query it again to verify the result. Confirm that declining
   approval does not make the change.
3. Query with the documented currency, date interval and pagination. Verify the returned records
   and separate currencies. Repeat CLI connection, creation/correction and query alternatives.

Use supported product controls to clean up synthetic records and revoke test access. Keep
credentials, financial content and one-time approval URLs out of evidence. Record metadata-only
outcomes and limitations. A failed journey blocks the initial publication; do not turn a local
test or a successful health response into a Production pass.

## Automatic deployment

Merge the reviewed change into `trunk`. **Publish customer docs** starts automatically for changes
under `apps/docs`, `infra/docs`, shared design/build inputs or its workflow. It checks out the exact
triggering revision, installs locked dependencies, runs docs artifact/reference/browser tests and
type checks, then deploys the independent `FidyDocs` Alchemy stack. Existing Production environment
credentials own deployment. There is no dispatch form, attestation JSON or separate publish command
in the release procedure.

After deployment, the workflow compares public `index.md` and `llms.txt` to the built files. Check
the Actions result and inspect live navigation, search, Markdown and the reference. Failed build or
test steps prevent deployment; a failed public artifact comparison marks the release failed.

After the initial successful deployment, point marketing discovery to the served docs hostname.
To restore an earlier docs snapshot, revert the source change through a reviewed PR; the merge
automatically deploys it. The site exposes current docs without a version archive.
