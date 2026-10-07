# MCP verification

Run the local runner regressions and the complete OAuth/MCP integration suite:

```sh
bun run test:ci-tools
bun run --cwd apps/server test:cloudflare cloudflare/oauth-agents
```

Run the Production journey with Bun. It uses real Claude Code and Codex clients,
a real browser, and the deployed ingress/Core/D1 path. A local canned model chooses
the tool calls, so the check needs no paid inference.

```sh
bun scripts/mcp/production-checks.ts --scope /private/path/scope.json --output /private/path/evidence.json
```

The scope is private operator configuration, not a credential. Supply these fields:

```json
{
  "approved": true,
  "authorization": "The user-authorized synthetic verification scope",
  "approvedAt": "CURRENT_UTC_TIMESTAMP",
  "namespace": "unique-synthetic-run",
  "fixtureUserId": "EXISTING_SYNTHETIC_USER_UUID",
  "portfolio": "EXISTING_SYNTHETIC_PORTFOLIO",
  "accountId": "CLOUDFLARE_ACCOUNT_ID",
  "databaseId": "PRODUCTION_D1_UUID",
  "revision": "DEPLOYED_TRUNK_COMMIT_SHA",
  "coreVersion": "DEPLOYED_CORE_VERSION_UUID",
  "ingressVersion": "DEPLOYED_INGRESS_VERSION_UUID",
  "workers": { "core": "CORE_WORKER_NAME", "ingress": "INGRESS_WORKER_NAME" },
  "binaries": { "claude": "/absolute/path/to/claude", "codex": "/absolute/path/to/codex" },
  "windowMinutes": 30,
  "maximumRequests": 150
}
```

Run the Production check on macOS, where the pinned Claude credential reader uses
the isolated native Keychain entry. Use the existing Wrangler and GitHub operator logins, installed Playwright Chromium,
Claude Code 2.1.289, and Codex 0.160.0. The runner resolves its temporary directory
to a canonical path before creating native profiles; macOS path aliases can
otherwise break Claude's profile lookup. The approval timestamp must be less than
15 minutes old when the run starts. `--validate-only` checks scope validity without
contacting Production. The runner refuses a deployment mismatch or a fixture
inventory containing real Users, existing Budgets, or active sessions/connections.
It approves browser pairing only for the existing synthetic User; it does not seed
or onboard another identity.

The isolated Codex profile marks Fidy as a required MCP server. This makes the
client wait for discovery before starting the canned-model journey; an optional
server can be omitted from its initial catalog while still connecting.

Both clients must pass OAuth with narrowed permissions, exact tool discovery,
Category reads, Budget creation, an atomic two-Transaction batch, cancellation,
confirmed deletion, repeated reads, natural access-token refresh, first-party
revocation, and subsequent access/refresh refusal. State and Audit assertions must
agree with client outcomes. The natural refresh wait takes about ten minutes.
OAuth/MCP Worker observations must match the approved versions and contain no
CPU-limit termination. Scheduled-job failures are counted separately in evidence.
The bounded run admits at most 150 observed OAuth/MCP requests, reserving ten for
cleanup. The complete real-client sequence exceeded the original 100-request
proposal because fresh native processes repeat discovery and initialization;
obtain approval for the 150-request scope before running it. Observed request
counts are an admission check, not a server rate limit.

A pass is written only after cleanup and private-profile removal succeed. Browser
sessions and connections are revoked and disposable Budgets deleted; four synthetic
Transactions and their immutable Audit remain. Evidence contains metadata only.
If cleanup fails, inspect the synthetic fixture before rerunning.

Identity/email delivery and the natural seven-day connection lifetime are outside
this bounded live run. Local integration checks cover exact expiry boundaries.

The local confirmation bridge uses `native-confirmation-hosts.ts`; it never runs
Production OAuth. See the opt-in instructions in the owning confirmation test.
