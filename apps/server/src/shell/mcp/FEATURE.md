# Hosted MCP

Users connect their own agents to `https://api.fidyapp.com/mcp` and use permitted
canonical operations. Financial behavior belongs to the operation's owner; MCP
owns discovery, transport and native confirmation. OAuth grants belong to
[OAuth Agents](../oauth-agents/contract.ts).

## Execution

Native client → public ingress Worker → authenticated Core → SQLite User Durable
Object → canonical operation owner → D1 and Audit.

Both supported protocols (`2026-07-28`, `2025-11-25`) execute MCP SDK work in the
Durable Object. Core authenticates and forwards bounded requests. Moving repeated
schema/SDK work out of Core fixed the observed Worker CPU exhaustion.
Application byte, deadline and residency bounds remain enforced; see the
[native admission contract](../../../cloudflare/mcp/contract.ts),
[runtime](../../../cloudflare/mcp/runtime.ts) and
[CPU investigation](../../../../../docs/research/hosted-mcp-free-cpu-990.md).

## User actions and manual checks

Use isolated native-client profiles and the bounded synthetic procedure in the
[Production runbook](../../../../../docs/operations/hosted-mcp-release.md).
Check canonical state and Audit as well as the client result; retain only safe
evidence. Run the same journey separately for Claude Code and Codex.

| User action                       | Manual check and expected result                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect an agent                  | Complete native OAuth and browser approval. Remove dashboard permission and choose seven days; connection metadata matches those choices.                                                                                 |
| Discover and read permitted tools | Discover tools and read Categories. Restricted tools are absent. Repeat reads and inspect Worker/DO outcomes; no CPU-limit termination or tool failure.                                                                   |
| Change records                    | Create a Budget, create two Transactions in an atomic batch, then delete the Budget through native confirmation. Cancel first, then accept; cancellation makes no change and acceptance has the expected state and Audit. |
| Continue access                   | Wait for the actual ten-minute access-token expiry and call from a new native process. Automatic refresh succeeds without extending the reviewed connection expiry.                                                       |
| Disconnect an agent               | Revoke through fresh first-party settings. Later calls and refresh must refuse; client logout removes local credentials. Reconcile synthetic effects through their owning lifecycles.                                     |

## Latest Production verification

**2026-10-07 · revision `63494fd4` · limited synthetic proof.**
[Evidence](../../../../../docs/research/hosted-mcp-free-990.evidence.json).

Claude Code 2.1.289 and Codex 0.160.0 passed native OAuth, Category reads, Budget
creation, a two-Transaction atomic batch, confirmed Budget deletion and natural
token refresh. Repeated reads passed 20/20 and 10/10 respectively. Core captured
68 MCP invocations with zero CPU-limit terminations. A follow-up checked native
cancellation without Budget deletion or accepted deletion Audit,
exact restricted catalogs (46 tools each), fresh confirmation for cleanup, and
post-revocation access/refresh refusal (401 / 400 `invalid_grant`). Cleanup left
zero active connections, browser sessions or Budgets; one lost fixture browser
session required operator revocation. Native logouts passed.

**Not verified live:** natural seven-day connection expiry, other clients and
other canonical operations. Provider identity/email approval used a synthetic
fixture. This proof does not establish every workload or Free-tier quota, or
authorize real-User launch.

[Cloudflare integration tests](../../../cloudflare/oauth-agents/) passed 195
tests across seven files, including all seven permission combinations and exact
absolute-expiry boundaries. The opt-in
[native-client harness](../../../../../scripts/mcp/native-confirmation-hosts.ts)
bridge was skipped; native confirmation was tested live instead. The harness is
not a Production runner. The reusable [Production checks](../../../../../scripts/mcp/README.md)
are being validated against the deployed synthetic fixture.

Update this document when behavior or execution changes. Keep only the latest
verification summary here; detailed evidence lives behind the link.
