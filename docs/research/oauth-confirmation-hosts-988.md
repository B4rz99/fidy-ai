# Browser confirmation host check — #988

**Implementation follow-up:** #988 now implements the selected native-form path. See the
[pinned ingress/Core/D1 host evidence](../../scripts/mcp/native-confirmation-hosts.evidence.json).
The research-time limitations below are historical, not the current implementation status;
production onboarding, deployment and launch remain unauthorized.

**Final decision (2026-10-05):** Claude Code/Codex native forms only, with authorized client approval
as the accepted trust boundary. This browser investigation is historical; the native contract in
[amended ADR 0033](../adr/0033-hosted-mcp-and-oauth-agent-grants.md) and #988 supersedes earlier policy assumptions.

**Scope/update:** this report tests browser URL elicitation, not native forms. See the
[latest-release follow-up](oauth-confirmation-latest-hosts-988.md) and
[native in-session investigation](oauth-native-confirmation-988.md). Native form approval works
in latest Claude and default Codex; the URL-specific Codex finding below does not contradict that.

Checked 2026-10-05 against the exact launch-host baselines in ADR 0033:
Claude Code **2.1.288**, Codex **0.160.0**, Pi **1.0.1**, with **Effect 4.0.0**.
These are version-specific results, not claims about every current or future release.

## Answer

| Host                                                | Browser interaction                                                   | Approval-and-resume with the unmodified pinned Effect server                                            |
| --------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Claude Code 2.1.288                                 | URL elicitation reached its Elicitation hook                          | **Passed the synthetic protocol round-trip** on 2026-07-28                                              |
| Codex 0.160.0, default settings                     | URL elicitation reached the app-server's client and returned `accept` | **Not established** on the default legacy protocol; this does not provide the modern keyed continuation |
| Codex 0.160.0, experimental modern protocol enabled | Rejected the modern URL input before presentation                     | **Failed**: `unsupported MCP tool input request`                                                        |
| Pi 1.0.1, built-in integration                      | Does not advertise elicitation                                        | **Unsupported**; Effect refused reverse elicitation and no continuation completed                       |

**It is not only a Pi problem.** Claude has working protocol building blocks. Codex has a
specific modern-protocol interoperability mismatch with the selected Effect release. Pi's built-in
integration lacks the interaction entirely.

This does **not** certify Fidy's sensitive mutations: #988's browser page, same-User/OAuthConnection
checks, atomic proof consumption, batch rollback and real canonical execution remain unimplemented.
No deployment or launch enablement follows from this check.

## What was actually exercised

A disposable loopback Effect HTTP server registered one inert `confirmation_probe` tool using
`McpServer.addTool`, with both the installed 2026-07-28 and 2025-11-25 adapters. The tool had empty
arguments and no Fidy identity, credentials, data, or domain effects.

For modern requests it returned Effect's public `McpSchema.InputRequired` containing URL elicitation
and a public `requestState`. A separate loopback review request set a **synthetic** approval flag.
Only a subsequent invocation with the echoed state and that independently set flag could mark the
probe completed. An elicitation `accept` alone was not treated as approval.

For legacy requests it used the public `McpServerClient` URL elicitation interface. Its result
explicitly reported that returning from legacy elicitation did not automatically authorize resume.

- **Claude:** actual installed CLI, isolated home/settings, `--strict-mcp-config`, only the inert
  MCP tool allowed. A loopback fake Anthropic Messages API emitted one canned tool call followed
  by a canned text reply; no inference provider was called. Its documented Elicitation hook made
  the synthetic review request and returned `accept`. The host itself repeated the original tool
  call with unchanged arguments, keyed `inputResponses` and echoed `requestState`. It received
  the completed result. The hook substitutes for a human/browser interaction; native interactive
  dialog rendering and an actual Fidy browser session were **not** exercised.
- **Codex:** actual installed `codex app-server --stdio`, isolated `CODEX_HOME`, ephemeral thread,
  public `mcpServer/tool/call`; no turn/model request. The probe's app-server client responded to
  `mcpServer/elicitation/request` by visiting the synthetic review URL and returning `accept`.
  This substitutes for a TUI user/browser. Default settings negotiated 2025-11-25 and successfully
  completed URL elicitation, but emitted no modern continuation. A separate run enabled
  `[features] mcp_2026_07_28 = true`; the CLI labels this feature **under development**, default
  false. That run negotiated 2026-07-28 but failed to parse Effect's URL input request.
- **Pi:** imported the installed Pi 1.0.1 built-in `McpServerConnection` and
  `createMcpToolDefinition`, then invoked the actual tool adapter without a model. This is a
  built-in integration probe, not a human-driven TUI session. Its initialization advertised only
  `roots`, not elicitation; Effect reported `McpReverseOperationUnsupported`. The tool returned
  an error, synthetic approval stayed false, and completion stayed false.

The scratch server, canned model fixture and subprocesses were stopped after the investigation.
No real credential or personal/financial data was involved. Reported Claude cost fields are its
calculation from canned usage, not evidence of a paid model request.

## Recorded observations

The exact key fields from the successful Claude continuation were:

```json
{
  "name": "confirmation_probe",
  "arguments": {},
  "inputResponses": { "review": { "action": "accept" } },
  "requestState": "public-probe"
}
```

The server observed two invocations, the independent synthetic review between them, and one
completion. The first invocation had no `requestState`; the second had the state shown above.

The unmodified Effect modern URL request delivered to both Claude and experimental Codex was:

```json
{
  "resultType": "input_required",
  "inputRequests": {
    "review": {
      "method": "elicitation/create",
      "params": {
        "mode": "url",
        "message": "Open the disposable approval page. No real data changes.",
        "url": "http://127.0.0.1:19788/review/public-probe"
      }
    }
  },
  "requestState": "public-probe"
}
```

Experimental Codex returned:

```json
{
  "error": {
    "code": -32600,
    "message": "unsupported MCP tool input request"
  }
}
```

It invoked the probe once, never presented the review, and completed nothing.

Pi's actual initialization included:

```json
{
  "protocolVersion": "2025-11-25",
  "capabilities": { "roots": {} },
  "clientInfo": { "name": "pi", "version": "1.0.1" }
}
```

It invoked the probe once, received `isError: true` with `URL elicitation unsupported or failed.`,
and completed nothing.

## Codex failure diagnosis

Codex 0.160.0's modern continuation parser uses RMCP's elicitation schema. Its lockfile pins
**rmcp 3.2.0**. That schema still requires a non-optional `elicitationId` for URL requests.
Effect's 2026 wire schema contains `mode`, `message`, and `url`, but no `elicitationId`.
This matches the 2026 specification's URL fields.

A **diagnostic-only** scratch variation added `elicitationId: "public-probe"` to that one outgoing
JSON URL input. With the experimental Codex feature enabled, the host then presented the URL
request, received synthetic approval, echoed the keyed response and `requestState`, and completed
in two invocations. This isolates the parser mismatch; it is **not** a passing unmodified-server
result or an approved production workaround. No Effect package, Fidy transport, dependency, or
production protocol was patched.

The observed keyed continuation fields are top-level `requestState` and `inputResponses`, **not**
a custom tool argument or an automatically added confirmation reference in `_meta`. Future #988
implementation should reconcile ADR 0033's “protocol metadata” wording with the actual standard
continuation interface rather than assuming a host invents custom metadata.

## Primary sources

1. [Accepted ADR 0033](../adr/0033-hosted-mcp-and-oauth-agent-grants.md), “Sensitive-operation handoff
   and resume”; [existing host report](hosted-mcp-interoperability-977.md), “Revised actual-host
   matrix”: exact baseline versions and previously unverified sensitive interactions.
2. [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests),
   “Respond to MCP elicitation requests” and “MCP client runtimes”: URL mode and declared modern
   elicitation support. [Elicitation hook](https://code.claude.com/docs/en/hooks#elicitation): the
   documented automation boundary used instead of a human dialog.
3. [MCP 2026 elicitation specification](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation),
   “URL Mode Elicitation Requests”: URL parameters and out-of-band completion; acceptance does not
   mean completion. [Multi-round-trip requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr):
   keyed input and echoed request state.
4. Installed `node_modules/effect/src/ai/McpSchema.ts:2809–2858`: public `InputRequired` contract.
   Installed `node_modules/effect/src/ai/internal/mcpSchema/v2026_07_28.ts:403–411`: modern URL
   schema. Published equivalents:
   [McpSchema](https://unpkg.com/effect@4.0.0/src/ai/McpSchema.ts),
   [2026 wire schema](https://unpkg.com/effect@4.0.0/src/ai/internal/mcpSchema/v2026_07_28.ts).
5. [Codex pinned continuation implementation](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/rmcp-client/src/tool_input.rs#L76-L110),
   lines 76–110 and 151–179: parse keyed input, handle it, repeat the call with state and responses.
   Lines 167–201 produce the observed unsupported-input error when input parsing fails.
6. [Codex pinned tool execution](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/rmcp-client/src/rmcp_client.rs#L864-L899),
   lines 864–899: only modern sessions use that continuation driver; legacy sessions return the
   ordinary tool result.
7. [Codex lockfile](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/Cargo.lock#L13008-L13011),
   lines 13008–13011: RMCP 3.2.0. Its published crate source, `rmcp-3.2.0/src/model.rs:3578–3597`,
   obtained from [the versioned crate artifact](https://crates.io/api/v1/crates/rmcp/3.2.0/download),
   requires `elicitation_id: String` in URL input. No default is provided.
8. Pi 1.0.1 published built-in
   [connection runtime](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.1/dist/extensions/mcp/runtime.js),
   lines 290–320: client construction registers roots and notification handlers, no elicitation
   handler. Its [tool adapter](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.1/dist/extensions/mcp/tools.js),
   lines 203–216: standard tool call, no custom continuation metadata.
9. [Pi MCP client 1.0.1](https://unpkg.com/@earendil-works/pi-mcp@1.0.1/dist/client.js),
   lines 234–236: ordinary `tools/call`; lines 318–335: requests without a registered handler are
   refused. The runtime evidence above confirms the integration does not advertise elicitation.

## What remains unresolved

- Native interactive browser UX, cancellation, delayed browser approval and retry controls have
  not been tested. The synthetic hooks/app-server responder approve synchronously.
- The real canonical/Core/D1 confirmation seam does not exist yet, so no host can presently be
  certified for real Fidy protected mutations.
- A supported Codex path needs a reviewed compatibility/upstream fix or a verified different host
  baseline. The diagnostic response edit is not authorization to introduce a hand-written adapter.
- Pi requires host-side interaction support or must refuse sensitive operations safely. Adding
  private model tools, trusting model approval, or weakening confirmation is not an alternative.
