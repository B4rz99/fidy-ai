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

Cleanup continuation, 21 October 2026, release `d50938e433193ba07e0207f0193f4f8881526f5a`:
after the User completed same-account Google identity confirmation, the original Inspector grant
was explicitly revoked in Accesos. The page reported successful revocation and retained the row
as Revocado. Inspector's reconnect could not restore access using its stored credentials; it
started a new OAuth review, which was cancelled. The client remained disconnected with
`Re-authentication required`. This establishes the observed client denial and original-grant
cleanup, not a separately captured refresh-token error or a successful live mutation.

Production retest, 21 October 2026, same release: after separate action-time approval and Google
identity completion, Inspector connected with a new seven-day read/write grant. It read the
November recurring workspace at revision 1. Both the exact synthetic stop-tracking decline and
acceptance closed the native form but left the parent tool call pending. Inspector recorded the
decline result; reconnecting and independently reading the workspace still showed revision 1
and the active plan. Acceptance was not confirmed as committed. The new grant was explicitly
revoked before freshness expired; Accesos displayed both test grants as Revocado. Reconnection
with retained credentials again required new authorization and remained disconnected. No new
replacement grant was approved. Production native mutation completion remains open.

Local diagnostic follow-up on the same revision used a temporary native workerd composition:
real ingress-to-Core service binding, real User Durable Object, and isolated D1. The existing
legacy delayed-acceptance case passed through that composition. Inspector 2.10.1 also completed
decline through the complete local chain, retaining the disposable Budget with zero accepted
deletions. A loopback-only synthetic OAuth provider then exercised Inspector's token-backed
transport: decline completed, and acceptance against a separate explicitly approved disposable
fixture completed with zero remaining Budgets and exactly one accepted deletion. These are
manual diagnostic probes, not committed regression tests or production confirmation evidence.
Temporary harnesses and local servers were removed/stopped after the run. The live stall is
still unresolved; another traced live call is needed before selecting a production fix.

A separately approved traced production grant on 21 October connected after renewing the expired
authorization request; the completed Google identity was recognized without another popup. The
seven-day read/write grant read revision 1 and displayed the exact synthetic stop review. On
decline, closed client instrumentation recorded the reply fetch starting with no response headers.
A subsequent workspace read also remained pending. Disconnecting the original transport released
the outstanding fetches: the decline reply returned 404 after approximately 242 seconds, and the
subsequent read returned 404 after approximately 165 seconds. A separate unauthenticated MCP
probe returned 401 in less than one second. Bounded Core observations showed successful MCP
invocations with roughly one-second processing times, but were attached late and do not prove
when the stalled reply first reached Core or isolate its cause. The client had no proxy environment
settings. No speculative production fix was deployed. The grant was explicitly revoked, with all
three Inspector rows displayed as Revocado; the traced client and tail were stopped.

Further temporary local probes passed delayed legacy acceptance through a real HTTP listener
and through the production-required erasure registry guard with native R2 and D1. This narrows
configuration differences without reproducing the live stall. Client-native production completion
remains open; the supported Codex/Claude Code host journey is separate from Inspector evidence.
