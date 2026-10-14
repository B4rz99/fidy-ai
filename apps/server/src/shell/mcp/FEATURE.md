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
[native admission contract](../../../cloudflare/mcp/contract.ts) and
[runtime](../../../cloudflare/mcp/runtime.ts).

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

## Automated coverage

The [Production runner](../../../../../scripts/mcp/README.md) repeats the five
journeys above with both native clients. Local public-ingress → Core/D1 tests cover
the failure cases without exhausting or corrupting the Production fixture:

| MCP behavior                                                                       | Existing integration checks                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration, metadata, callbacks, review and narrowed permissions                 | [Ingress](../../../cloudflare/oauth-agents/oauth-ingress.test.ts), [discovery](../../../cloudflare/oauth-agents/oauth-discovery.test.ts)                          |
| Stateless 2026 and session-based 2025 transport, bounds, deadlines and disconnects | [Free-tier handoff](../../../cloudflare/oauth-agents/oauth-mcp-free.test.ts), [native residency](../../../cloudflare/oauth-agents/oauth-native-residency.test.ts) |
| Canonical calls, atomic batches, ambiguous delivery and shared allowances          | [Canonical execution](../../../cloudflare/oauth-agents/oauth-canonical.test.ts), [allowances](../../../cloudflare/oauth-agents/oauth-allowance.test.ts)           |
| Sensitive confirmation, cancellation and replay refusal                            | [Confirmation](../../../cloudflare/oauth-agents/oauth-confirmation.test.ts)                                                                                       |
| Refresh rotation, exact expiry, replay, connection inspection and revocation       | [Refresh](../../../cloudflare/oauth-agents/oauth-refresh.test.ts), [management](../../../cloudflare/oauth-agents/oauth-management.test.ts)                        |

Run all nine files with `bun run --cwd apps/server test:cloudflare cloudflare/oauth-agents`.
Canonical financial behavior remains the owning feature's testing responsibility.
