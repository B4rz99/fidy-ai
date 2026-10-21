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

Supported-client production cancellation, 21 October 2026, release
`d50938e433193ba07e0207f0193f4f8881526f5a`: Codex 0.160.0 completed native DCR/OAuth
with the separately approved seven-day read/write connection. A canned local model invoked only
the exact synthetic recurring stop-tracking operation; it used no paid inference. The native
confirmation was cancelled, and the completed tool result contained `user_action_required`.
The diagnostic reported one expected/received result, native form answered, and passed. An
independent November browser read retained `PRUEBA QA CHAT RECURRENTE 20261017` as upcoming
on 18 November. The connection was immediately revoked in Accesos, which confirmed Revocado;
native logout then removed the isolated client's OAuth credentials. All five test connection
rows were revoked. This closes the supported Codex cancellation check for this operation;
it does not establish acceptance, Claude Code production completion, the full native journey,
or a cause/fix for the separate legacy Inspector stall.

Follow-up diagnosis, 21 October: the production audit login helper incorrectly required a manually
submitted callback file even after the native CLI exited successfully. It now accepts the native
client's successful completion after publishing the authorization request, while retaining failure
for nonzero exit or absent authorization. A new regression failed before the fix; all 22 focused
native login, host, production-check and cleanup tooling checks then passed, as did the project
TypeScript build. This is audit tooling, not a production authentication-policy change.

Claude Code 2.1.289 completed OAuth twice against an isolated disposable local provider, with a
real localhost listener and the browser's authentication-success page. The corrected supervisor
reported exit 0 and success without transferring a callback URL manually. Those local credentials
were logged out before the separately approved production continuation below.

A separate six-second legacy concurrency probe used Inspector 2.10.1's installed fetch tracker
and its actual `@modelcontextprotocol/client` 2.2.0 transport against a synthetic Node HTTP server.
The cancellation reply reached that server, the parent tool completed, and a second read completed
while the review was pending. This does not reproduce the live stall or prove behavior through
Fidy's Worker/D1 chain; it narrows the generic client-serialization hypothesis without diagnosing
production. No speculative runtime patch or deployment was made. A new live Inspector comparison
needs separately approved access and arrival-time-correlated observations.

Supported Claude Code production cancellation, 21 October 2026, same deployed release: after
Google identity confirmation, the User explicitly approved a new read/write connection for seven
days. Claude Code 2.1.289 completed the native localhost OAuth callback. The canned local model
invoked only the exact synthetic recurring stop-tracking request and cancelled its native form.
The tool returned `user_action_required`; closed evidence reported one expected/received result,
native form answered, and passed. An independent browser read retained the November occurrence
as upcoming on 18 November. Accesos confirmed immediate individual revocation, and native logout
cleared the isolated client's credential. All six audit connections were revoked. Both supported
clients now have live cancellation evidence for this operation; acceptance, full native journeys
and the separate legacy Inspector stall remain outside that proof.

Inspector network-timing continuation, 21 October 2026, same release: a separately approved
seven-day read/write connection repeated only the synthetic stop-tracking cancellation. Closed
Undici diagnostics recorded the parent POST sent after 132 ms and response headers after 5,411 ms.
The cancellation POST was created locally but had no send event until disconnect, 186,758 ms
later; its eventual response was 404. The isolated Node 26.5.0 process negotiated HTTP/2 with
bundled Undici 8.7.0. Increasing its client pipelining to two did not release the queued request.
These observations locate a client-side dispatch delay; they do not establish its underlying cause.

Reconnecting the same approved grant with a process-local Undici 8.12.3 dispatcher restricted to
HTTP/1.1 dispatched cancellation after 169 ms and received HTTP 202 after 1,346 ms. The parent
completed but returned `unavailable`, not the required `user_action_required`, so this is not a
cancellation pass or a production fix. The following read failed. The initial synthetic TLS baseline was invalid: importing external Undici before initializing native
fetch replaced the dispatcher under test. Its two passes did not establish bundled 8.7.0 behavior;
the corrected comparison below supersedes that claim.
No product/runtime patch was justified by this comparison. Inspector and its diagnostic process
were disconnected/stopped. Independent browser readback retained the November occurrence.
Revocation of this newest grant explicitly required recent identity confirmation; it remains
pending same-account provider completion. Earlier six audit grants remain revoked. Retain this
cleanup gap until Accesos confirms revocation; do not infer it from stopping the client.

Cleanup continuation, 21 October 2026: after the User completed the same-account Google popup,
a page refresh restored the authenticated Accesos list. Explicit individual revocation of the
newest Inspector connection returned “Acceso revocado. Las acciones ya realizadas se conservan.”
and changed its state to Revocado. All seven audit connection rows were then revoked. This
closes the pending cleanup above; it does not resolve the Inspector cancellation failure.

Corrected Inspector dispatch reproduction, 21 October 2026: initialize native fetch before any
external Undici import. With the same pinned MCP client, disposable bearer and loopback TLS HTTP/2
server (100 streams), both cancellation-only and concurrent-read cases failed under Node 26.5.0's
bundled dispatcher: `cancellationReceived: false`. Using the pinned external Undici 8.12.3 dispatcher
with native fetch made both pass with `user_action_required`, without disabling HTTP/2 or TLS
validation. The runtime's bundled HTTP/2 busy check serializes nonempty streaming request bodies;
the external dispatcher permits those independent streams. The earlier nominal bundled baseline
was accidentally using the external dispatcher and is explicitly corrected above.

The isolated `tools/mcp-inspector` launcher installs that process-local workaround and retains the
red-capable baseline command alongside the two passing transport tests. Fidy's existing legacy
canonical integration now covers cancellation after 6 and 30 seconds and decline after 30 seconds,
asserting `user_action_required` and retained data; acceptance remains covered separately. This
fixes the reproducible client dispatch failure locally. Production Inspector semantics remain open
until a newly approved grant verifies cancellation through the corrected HTTP/2 client. The prior
HTTP/1.1 `unavailable` result is not counted as resolved. All seven previous audit grants are revoked.

The follow-up uses policy-eligible Inspector 2.11.0, MCP client 2.3.1 and Undici 8.12.3 in an
isolated development tool. Both baseline cases still fail without its preload; both pass with it.
The actual Inspector web UI also connected to a disposable local TLS HTTP/2 server, displayed the
native form, and completed Cancel with `user_action_required` (about four seconds including the
manual click). No production access was created by this local test. The full OAuth/MCP adapter
suite passed 227 tests with one existing skip; TypeScript, ordinary/type-aware lint, dependency
policy (zero failures) and both transport regressions passed. The npm bulk advisory endpoint
reported no advisories for the isolated tool's 118 installed package names. Workspace Gate runs
the new transport regressions on CI; production verification remains a distinct pending step.

Production Inspector cancellation closure, 21 October 2026, 16:19–16:22 UTC: after same-account
Google sign-in, the User approved the corrected-client test connection with read/write for seven
days. The isolated Inspector 2.11.0 launcher with Undici 8.12.3 completed OAuth and discovered
56 tools over MCP 2025-11-25. `getRecurringWorkspace` read November revision 1; the exact synthetic
`applyRecurringEdit` stop-tracking request then displayed its native form. Clicking Cancel
completed the original parent call with declared `user_action_required`, not `unavailable` or a
timeout. Inspector reported 22,368 ms for the parent and 13,466 ms for elicitation, including the
manual review interval; these are not cancellation POST network latencies.

The client was disconnected immediately. Accesos confirmed individual revocation with “Acceso
revocado. Las acciones ya realizadas se conservan.” and all eight audit connection rows were
Revocado. Independent browser readback retained the synthetic November occurrence as upcoming on
18 November. The isolated Inspector process was stopped and its revoked-credential state removed.
This closes the legacy Inspector cancellation gap for this exact operation using the corrected
launcher. It does not establish acceptance, other sensitive tools, or an unmodified Inspector on
Node's affected bundled dispatcher. No Fidy production runtime deployment was needed; the fix is
confined to the operator client's transport. No edit was accepted and no Transaction was deleted.
