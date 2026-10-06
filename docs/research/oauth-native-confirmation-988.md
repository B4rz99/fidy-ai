# Native in-session confirmation — #988

**Implementation follow-up:** #988 now implements the selected native-form path. See the
[pinned ingress/Core/D1 host evidence](../../scripts/mcp/native-confirmation-hosts.evidence.json).
The research-time limitations below are historical, not the current implementation status;
production onboarding, deployment and launch remain unauthorized.

**Final decision (2026-10-05):** support **Claude Code and Codex only**, with native forms and
OAuth-authorized client acceptance as the explicitly accepted confirmation trust boundary. Pi,
OpenCode and extensions are excluded. See [amended ADR 0033](../adr/0033-hosted-mcp-and-oauth-agent-grants.md)
and #988. Earlier pending-policy statements below describe the research-time contract; they are
superseded by this decision, not new implementation or launch evidence.

Checked **2026-10-05**, final evidence timestamp **15:51:29 UTC**. Research only: no production
code, dependency, security standard, ADR, issue contract, deployment or launch configuration changed.

## Question and answer

The User prefers: agent proposes a sensitive action → the harness presents native approval controls
inside the session → the User approves or cancels → the agent finishes, **without a browser detour**.

**Claude Code and Codex can do that interaction today. Pi's built-in MCP integration cannot.**
The previous investigations tested **URL elicitation**, not native **form elicitation**. Codex's
URL-format mismatch does not prevent this native-form workflow. Calling Codex generally unable to
perform in-session sensitive-action confirmation would be incorrect.

A second finding is separate from usability: **stock native elicitation is client-asserted approval,
not independently verified first-party human approval**. Adopting it as authority changes #988's
current threat model and explicit security policy. It is not merely a different renderer for the
existing browser proof.

## Versions and method

Publisher npm `latest` tags were rechecked at the start of this investigation. Exact installed
binaries again reported Claude Code **2.1.289**, Codex **0.160.0**, Pi **1.0.3**. These remain the latest
normal releases checked, not prereleases. Package publication/integrity evidence is in the
[latest-release report](oauth-confirmation-latest-hosts-988.md#latest-published-releases-verified).
The disposable server used **Effect 4.0.0**, the application-selected dependency.

This time both **actual interactive CLIs** ran in PTYs against isolated homes and canned loopback
model APIs. Native dialogs were rendered by the released CLIs and operated using scripted operator
keystrokes. **No elicitation hook substituted for those native dialogs.** Canned model calls requested
only the inert probe tool. No provider inference, real financial data, authenticated Fidy User,
OAuth credential, first-party browser session or canonical/Core/D1 mutation was involved.

Pi's installed built-in connection and tool adapter were invoked without a model. There is no native
elicitation registration to drive in its current connection runtime. Supplementary Codex app-server
runs exercised decline/cancel and its experimental modern protocol; these are clearly distinguished
from the actual default-protocol CLI UI runs.

[Normalized executed-probe evidence](oauth-native-confirmation-988-evidence.json) records the form,
versions, observed native responses/continuations and synthetic completion counts. Raw scratch
transcripts and drivers remain in `/tmp/fidy-988-native/`; this report and the normalized observations
are the durable research artifacts. They are not a formal repository test suite or security certificate.

## Actual native interaction results

| Host                | Acceptance                                                                | Cancellation                                                | Transport behavior                                                         |
| ------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| Claude Code 2.1.289 | Native form rendered; accepted response produced one synthetic completion | Native Escape returned `cancel`; zero synthetic completions | 2026-07-28 keyed continuation; unchanged tool arguments                    |
| Codex 0.160.0       | Native form rendered; accepted response produced one synthetic completion | Native Escape returned `cancel`; zero synthetic completions | Default legacy server-to-client form request; original tool call completes |
| Pi 1.0.3 built-in   | No elicitation capability; native interaction refused                     | No form to cancel                                           | Roots-only capabilities; zero synthetic completions                        |

### What the User actually sees

The probe requested only a boolean confirmation, defaulting to **false**, with this server-owned
Spanish disclosure and schema title:

> Fidy: eliminar el presupuesto Mercado de este ejemplo. Esta prueba no modifica datos reales.
> ¿Confirmas?

**Claude's actual native UI** identified the requesting MCP server, displayed `Confirmar la acción`
as a checkbox, and offered **Accept / Decline** plus Escape to cancel. Checking the box and choosing
Accept caused the CLI to repeat the tool call automatically with:

```json
{
  "name": "confirmation_probe",
  "arguments": {},
  "inputResponses": { "review": { "action": "accept", "content": { "confirm": true } } },
  "requestState": "public-native-probe"
}
```

**Codex's actual native UI** first displayed its ordinary tool-execution permission gate: Allow,
Allow for this session, Always allow, or Cancel. The probe chose **Allow once**. After that distinct
local permission gate, the server's exact-action form appeared, with the Spanish disclosure,
`Confirmar la acción`, **True / False**, and Escape to cancel. Selecting True returned:

```json
{ "action": "accept", "content": { "confirm": true } }
```

Codex then finished the original tool call. It did **not** need a second model request, explicit
“continue” chat message, browser, or its experimental `mcp_2026_07_28` flag. Its initialization
requested `2025-06-18`; the server handler used `2025-11-25`, with form elicitation advertised.

These are **generic harness-controlled forms**, not bespoke Fidy buttons. Fidy can supply the exact
review text and supported schema; the host controls widget layout and system button wording. A
polished titled-choice `Confirmar / Cancelar` schema remains a follow-up UX test, not a claim made
from the boolean probe.

Neither the ordinary Codex Allow/Always allow gate nor a server tool's `destructiveHint` is the
exact-action confirmation. The server-owned form is a separate interaction. A future implementation
must not infer sensitive-action approval from the user having allowed the tool generally.

### Additional protocol checks

Codex's actual app-server returned `decline` and `cancel` on the default path: zero synthetic
completions. Its experimental 2026 form path accepted with one synthetic completion and declined or
cancelled with zero. **Form-mode continuation interoperates even though the separately investigated
modern URL-mode schema does not.** No production compatibility patch was applied.

A first manually driven Codex probe waited beyond the scratch Bun server's idle deadline and failed
without completion. The fixture's idle timeout was raised to 120 seconds and both default native
accept/cancel journeys were rerun successfully. This is not evidence for production human-wait
budgets: a legacy form holds a request open, whereas modern continuation can release it. Production
pending-work bounds, timeouts and cancellation semantics still require real-ingress verification.

## What does native acceptance prove?

### Useful boundary: the model is not the native approval widget

In the tested honest hosts, the model requested only `arguments: {}`. The native response was
handled by the host's UI/integration, outside canonical model-chosen tool arguments. In Claude it
appeared in the standard top-level `inputResponses`, not a model argument like `confirmed: true`.
In Codex the host answered the server's reverse form request.

Thus native approval can protect an honest configured session against the model simply deciding to
call a sensitive tool. It is **not correct** to say that the ordinary model can approve it merely by
adding `confirmed: true` to the canonical input. Fidy should never expose that as an authority input.

### Limit: the server sees the client's assertion, not authenticated human interaction

The standard response consists of `action`, submitted `content` and optional metadata. It has no
separate Fidy-authenticated User proof, signed trusted-UI event, hardware user-presence assertion, or
attestation of which program generated the response. OAuth authenticates the connection acting on
the User's behalf; it does not independently prove that the User just operated a native widget.

Two primary-source/evidence observations support this distinction:

1. Claude's **officially supported Elicitation hooks can return an acceptance and content without
   displaying the dialog**. Honest-host policy can therefore automate approval. An `accept` does not
   necessarily imply a human clicked anything, even when the response comes from real Claude Code.
2. A direct disposable HTTP client fetched the same modern input-required result, copied its public
   `requestState`, claimed `clientInfo.name: "claude-code"`, and sent the same keyed
   `accept`/`confirm: true` continuation. No dialog, model or person was involved. The deliberately
   inert fixture, whose only gate was that client response, completed once. The normal MCP response
   alone cannot distinguish that fabricated response from native acceptance.

The second observation demonstrates a **protocol trust boundary**, not a Fidy vulnerability. Fidy's
real confirmation owner is not implemented, and the existing canonical path refuses without its
required proof. No real OAuth credential was used. In production, an arbitrary unauthenticated
client would still fail OAuth checks; the relevant adversary is an already-authorized malicious or
automated client, or one holding a stolen valid agent credential.

A public challenge or a server-signed `requestState` can bind exact work and prevent state tampering.
It **does not** prove a human accepted: the authorized client can echo the public challenge and assert
acceptance. Matching the exact User/connection/input/revision and consuming evidence once are still
necessary but do not by themselves create independent human approval.

Do not fix this by asking for passwords, OTPs or confirmation secrets in form fields. MCP forbids
collecting sensitive credentials through form elicitation, and Fidy forbids putting confirmation
secrets into model/agent channels. Recognizing a client name or capability advertisement is not
attestation either.

## Current-contract conflict

[#988](https://github.com/B4rz99/fidy-ai/issues/988) asks for the existing first-party browser/host
handoff contract. [ADR 0033](../adr/0033-hosted-mcp-and-oauth-agent-grants.md), lines 154–188, explicitly
states that elicitation acceptance is **never confirmation evidence** and requires a fresh same-User
WebSession. [`SECURITY_STANDARDS.md`](../../SECURITY_STANDARDS.md), lines 194–198, likewise says:

> Public references, host elicitation acceptance, model claims and hosted-only evidence grant nothing.

Switching to native client acceptance as mutation authority requires an explicit review/amendment of
**all three**, not just a browser layout change. No such amendment has been made by this research.

## Solution options and recommendation

There are two distinct choices; the report does not silently choose weaker authority requirements.

### Option A — native client confirmation is the intended safety boundary

If the product intends to trust the User's configured harness to collect approval:

- Amend #988/ADR/security policy to explicitly name **client-asserted exact-action approval**, and
  acknowledge automated/malicious clients and stolen OAuth credentials are not independently
  stopped by the native confirmation boundary. Do not describe it as first-party human proof.
- Use **native form elicitation** on Claude and Codex, with an immutable server-owned Spanish
  effect review, safe default, exact User/connection/operation/canonical-input/revision/expiry
  binding, bounded pending work and atomic single-use consumption plus live credential, scope,
  Consent, domain and whole-batch guards. Decline/cancel/missing responses grant nothing.
- Keep continuation fields separate from canonical tool arguments. Use the Effect-owned modern
  continuation or legacy form transport selected by capability/protocol, not custom `_meta` or
  host-name detection. Modern state is public and confers no authority alone.
- Pi's **ordinary authorized operations remain usable**. Sensitive operations refuse until its
  built-in MCP integration gains native form support. An upstream contribution is a route to
  eventual no-plugin support, not an available feature or delivery commitment. Do not impose a
  Fidy plugin or browser fallback the User has rejected.
- Prove the real canonical/Core/D1 behavior with adversarial, concurrency, rollback, timeout and
  human-driven host journeys before claiming implementation completion or launch support.

**Recommendation if trusting the harness is acceptable:** this native-form design, not the earlier
browser-link + explicit-repeat workaround. The native interaction is now demonstrated on both
Claude and default Codex; waiting for Codex's URL-mode fix is unnecessary for this choice.

### Option B — keep independently verified first-party human approval

If an agent's credential/client must **not** be able to approve its own sensitive requests, the
current browser proof cannot simply be replaced with stock native MCP forms. A no-browser alternative
would need a separately authenticated, user-present approval channel and suitable host integration;
stock MCP elicitation supplies neither that attestation nor a cross-host implementation. No such
solution has been established here.

Do not weaken the first-party requirement or expose sensitive mutations while waiting for that
capability. Native forms can be UX, but cannot grant authority under the unchanged contract.

**Decision needed before implementation:** accept the harness as the confirmation trust boundary
(Option A), or retain independent first-party approval (Option B). Separately, decide whether
unsupported Pi sensitive operations are acceptable until upstream support exists. This investigation
supports no claim that all three stock hosts currently meet both requirements.

## Primary sources

- Executed native CLI, Pi adapter, app-server and fabricated-client observations:
  [normalized evidence](oauth-native-confirmation-988-evidence.json). These are this investigation's
  own observations, not statements copied from vendor documentation.
- [MCP 2025-11-25 elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation),
  “Form Mode Elicitation Requests”, “Response Actions”, “Identifying the User” and “Form Mode Security”:
  standard typed forms, accept/decline/cancel, authorization-derived identity and prohibition on
  collecting sensitive credentials.
- [MCP 2026-07-28 elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation),
  “Form Mode Elicitation Requests” and “Response Actions”: `inputResponses` in a retried request;
  standard response data, not a human-attestation mechanism.
- [Claude native MCP elicitation](https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests):
  interactive in-session collection.
- [Claude Elicitation hooks](https://code.claude.com/docs/en/hooks#elicitation), “Elicitation output”:
  supported programmatic acceptance/content **without showing the dialog**. This is independent
  evidence that acceptance is not necessarily a human interaction.
- [Codex 0.160.0 native elicitation UI](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/bottom_pane/mcp_server_elicitation.rs#L1148-L1205),
  lines 1148–1205: separate local permission decisions and collection of form content into client
  acceptance. Lines 1121–1135 handle cancellation.
- [Codex test Responses API fixtures](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/tests/common/responses.rs#L773-L835),
  lines 773–835 and 969–995: first-party canned SSE shapes used to avoid real inference in the TUI
  probe. This does not certify live provider behavior.
- [Pi 1.0.3 MCP connection runtime](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.3/dist/extensions/mcp/runtime.js),
  lines 290–320: roots and notification registration, no elicitation handler;
  [published MCP documentation](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.3/docs/mcp.md),
  “Permissions”: extension permission gates are possible, not stock native elicitation support.
- [`effect@4.0.0` modern protocol adapter](../../node_modules/effect/src/ai/internal/mcpProtocol/v2026_07_28.ts),
  lines 345–357: structurally decodes client-supplied continuation fields; does not independently
  authenticate a human acceptance. This is a dependency-checkout reference and requires the
  repository's pinned dependencies; the public wire contract is the cited MCP specification.
- [ADR 0033](../adr/0033-hosted-mcp-and-oauth-agent-grants.md#sensitive-operation-handoff-and-resume),
  [#988](https://github.com/B4rz99/fidy-ai/issues/988),
  [`SECURITY_STANDARDS.md`](../../SECURITY_STANDARDS.md): current first-party requirement and explicit
  exclusion of host acceptance as authority.

## Follow-up: could a Pi extension add this?

The User subsequently asked whether a Pi extension could provide the missing interaction. **Yes,
a dedicated MCP adapter extension is feasible**, based on the released public APIs, but an
end-to-end extension has not been built or tested in this investigation.

There are two different extension shapes:

- A `tool_call` gate can show `ctx.ui.confirm` or `ctx.ui.select` before an existing built-in MCP
  tool executes. That works with Pi's tool pipeline today, including nested codemode calls, but
  **does not add server-requested elicitation**. It neither advertises form capability nor answers
  the MCP server's pending form. It is not sufficient for the proposed server-owned exact-action
  handoff by itself.
- An adapter can own the Fidy MCP connection, discover/register the existing server tools, advertise
  `elicitation.form`, and register an `elicitation/create` request handler that drives Pi's native
  dialog and returns the standard result. Pi's separately published `McpClient` exposes both
  constructor capabilities and `setRequestHandler`; these are public APIs, not monkey patches.
  Its legacy form protocol is sufficient for the already demonstrated server form path. OAuth,
  private credential storage, dynamic tool updates, cancellation, bounded waits and non-UI refusal
  would all need implementation and verification. Other servers can remain on built-in MCP, but
  Fidy must not be connected/exposed twice.

Pi 1.0.3's extension API exposes MCP server **configuration/registration**, not access to its
already-connected built-in client or an elicitation-handler registration hook. Merely calling
`pi.registerMcpServer` continues using the unsupported built-in connection. A drop-in enhancement
that preserves the existing connection therefore needs an upstream Pi integration hook/change.
Pi also supports replacing its entire built-in MCP integration via an extension owning `/mcp`,
but that is broader than a Fidy-only adapter and would need deliberate product approval.

**Recommendation:** if installation is now acceptable, prototype the focused Fidy adapter first;
prefer upstream native elicitation support long-term. Do not hard-code a parallel operation list
or expose a model-callable `approve` tool. This solves the Pi UX/transport gap, **not** the separate
first-party-proof requirement: its response still represents client-controlled approval, just like
Claude/Codex. An extension being Fidy-authored is not server-verifiable proof that a human clicked.

Primary references for this feasibility conclusion:

- [Pi 1.0.3 extension docs](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.3/docs/extensions.md),
  “Tool exposure”, “MCP servers”, “UI and modes”: native UI, tool pipeline hooks and registration.
- [Pi extension UI declarations](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.3/dist/core/extensions/types.d.ts),
  lines 75–80 and 1343–1355: dialogs and configuration-only MCP registration/inspection.
- [MCP server configuration declarations](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.3/dist/core/mcp-servers.d.ts),
  lines 17–99: current configuration has no elicitation hook or client injection.
- [Pi MCP 1.0.3 public client](https://unpkg.com/@earendil-works/pi-mcp@1.0.3/dist/client.d.ts),
  lines 8–17 and 42–48; [implementation](https://unpkg.com/@earendil-works/pi-mcp@1.0.3/dist/client.js),
  lines 125–145 and 169–175: capability advertisement and incoming-request handler registration.
- [Pi MCP docs](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.3/docs/mcp.md),
  “Permissions” and “Replace the built-in MCP support”: local gates and supported replacement.
- [Pi packages](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.3/docs/packages.md),
  “Install and manage packages”: a distributed extension requires a one-time user installation.

## Unresolved verification

No real browser/identity/credential/mutation seam was tested, no security amendment is approved, and
no human manually operated these journeys. The final native Spanish choice layout, slow-user and
production request bounds, disconnect/delivery-ambiguity behavior, batch disclosures, atomic evidence
consumption and real OAuth negative cases remain implementation/test work. Pi upstream form support
has no verified release or delivery timeline. No release, deployment or onboarding is authorized.
