# Hosted MCP

Users connect their own agents to `https://api.fidyapp.com/mcp` and use permitted
canonical operations. Financial behavior belongs to the operation's owner; MCP
owns discovery, transport and native confirmation. OAuth grants belong to
[OAuth Agents](../oauth-agents/contract.ts).

Public client registration validates supported redirects, grants and scopes under the existing
16 KiB body limit. Unsupported self-asserted metadata is discarded before response or persistence,
as required by [RFC 7591 section 2](https://www.rfc-editor.org/rfc/rfc7591.html#section-2).
Metadata URLs are not fetched or displayed. Browser decisions retain strict excess-field rejection;
registration does not create an OAuth connection or authorize canonical operations.

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

## Production audit, 20 October 2026

Release `eb9374c92dd97a63f45a6a108a8660b0cfe39842` accepted the official MCP Inspector
2.10.1 registration, completed Google-backed browser approval for seven days with only `read write`,
negotiated `2025-11-25`, discovered tools, and read the November recurring workspace. The client
performed automatic access-token refresh; reconnecting restored reads after the old caller-bound
transport returned 404. This establishes this Inspector journey, not the separate Claude Code/Codex
Production runner or continuous transport recovery across refresh.

Live recurring lifecycle calls displayed the exact native elicitation, but both decline and acceptance
attempts timed out at the client. Independent workspace reads still returned revision 1 with the
synthetic plan active. A later call returned declared `unavailable` before review. Closed Worker
observations for that later run showed successful ingress/DO outcomes without CPU termination;
they do not diagnose the earlier timeout. The same Inspector's decline completed against the isolated
local Worker/D1 confirmation bridge, leaving its disposable Budget and accepted-mutation count unchanged.
The 14 confirmation integration checks passed. Production mutation completion and cancellation remain
open; neither a displayed review nor a local pass establishes them.

Temporary-grant revocation was attempted after browser freshness expired and returned 401 while the
same live cookie still permitted listing. Issue #1422 distinguishes that refusal and offers identity
confirmation. The grant has not yet been confirmed revoked; native provider-popup completion is
required before cleanup and subsequent access/refresh refusal can be verified. No production
Transaction was deleted during this run.
