# OpenCode v2 native confirmation — #988

**Implementation follow-up:** #988 now implements native forms for Claude Code/Codex only. See the
[pinned ingress/Core/D1 host evidence](../../scripts/mcp/native-confirmation-hosts.evidence.json).
OpenCode remains unsupported; the research-time limitations below are historical, not the
current Claude Code/Codex implementation status. Production onboarding, deployment and launch
remain unauthorized.

**Subsequent decision (2026-10-05):** OpenCode, Pi and extensions are out of scope. The User selected
Claude Code/Codex only and accepted authorized client-native approval without independent human
attestation. [Amended ADR 0033](../adr/0033-hosted-mcp-and-oauth-agent-grants.md) and #988 are authoritative;
this report preserves the earlier investigation, not a current support proposal or policy blocker.

Checked **2026-10-05**, observation timestamp **17:14:28 UTC**. Follow-up to the
[native Claude/Codex/Pi investigation](oauth-native-confirmation-988.md). The User has now explicitly
accepted **one-time Pi extension installation** and requested OpenCode v2 in the intended host matrix.
Neither statement approves replacing independent first-party proof with client-asserted approval;
that security decision remains separate.

## Answer

**OpenCode v2 implements native server-requested MCP forms. However, the latest v2 release tested,
2.0.23, did not deliver the newly created confirmation form live to its TUI in our probe.**

The backend created the correct form and the tool remained pending with no synthetic effect. After
reattaching the TUI, its native form appeared. Accepting it resumed the exact modern invocation and
completed once; dismissing a fresh legacy form returned `cancel` and completed zero times.

Therefore this is **native implementation present, clean journey not yet supported/verified**—not
Pi's missing-capability situation. Reconnecting is diagnostic evidence, **not** a proposed User
workaround. Do not certify OpenCode for sensitive operations until its normal native journey passes.

## Correct v2 release identity

`opencode-ai@latest` and GitHub's ordinary latest release still point to v1 (**1.18.34**). They are
not how we selected v2. The official v2 installer reads the
[publisher's CLI update endpoint](https://opencode.ai/update/api/latest/cli/npm), which returned:

- package: **`@opencode/cli`**, version **2.0.23**;
- release source commit: **`63e33bc4dc7d93ccdfb008908e12e4762f8361b8`**;
- `npm view @opencode/cli dist-tags` independently returned `latest: 2.0.23`;
- platform package **`@opencode/cli-darwin-arm64@2.0.23`** was packed/extracted in scratch;
- the actual binary printed **`opencode v2.0.23`**.

The official intro page still linked 2.0.6 downloads when fetched; the updater and npm tag are the
release-selection evidence here, not those stale download links. No global install, installer
execution, repository dependency update or postinstall script was needed.

[Normalized probe evidence](oauth-native-opencode-988-evidence.json) preserves the exact package
integrity and observations. Primary publisher metadata:
[@opencode/cli](https://registry.npmjs.org/@opencode%2fcli),
[platform release](https://registry.npmjs.org/@opencode%2fcli-darwin-arm64/2.0.23), and
[official installer](https://opencode.ai/v2/install), lines 176–206 as retrieved. Tags/update endpoints
are mutable; the exact tested version and source commit above are fixed.

## Test method and results

The released CLI ran in a real PTY with isolated HOME/XDG directories, a custom **loopback-only**
Chat Completions provider returning canned tool calls, and the existing inert Effect **4.0.0** probe.
No real model inference, Fidy User, OAuth credential, financial record or domain mutation was used.
Native choices were operated with scripted terminal keystrokes. No plugin or source patch was loaded.

Only the probe's ordinary local tool permission was preallowed; that is distinct from the server's
exact-action form. `codemode: false` exposed the inert tool directly to the canned provider, avoiding
unrelated script/model work. Production Code Mode integration remains an additional test seam.

| Path                                                             | Observed outcome                                                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Default `protocol: legacy`                                       | Advertised form capability; exact tool called; newly created form did not appear live; no completion       |
| `protocol: auto`, negotiated 2026-07-28                          | Same live-display limitation; backend form existed; no completion before decision                          |
| Separate loopback OpenCode API server + attached TUI             | Reproduced the pending form/live-display distinction; authenticated local API listed the server-owned form |
| TUI reattached to pending modern invocation; native Yes selected | Standard keyed continuation with unchanged arguments; one synthetic completion                             |
| Fresh legacy invocation; TUI reattached; native Escape           | Standard `action: cancel`; zero synthetic completions                                                      |

The backend form had `sessionID: "global"`, title `probe is requesting input`, metadata
`kind: "mcp-elicitation"`, and the required boolean `Confirmar la acción`, default false. After
reattachment, the actual native UI showed the Spanish exact-effect message, **Yes / No**, with No
selected by default, and **Escape to dismiss**. It was not a browser link or an ACP-host dialog.

The successful modern continuation was:

```json
{
  "name": "confirmation_probe",
  "arguments": {},
  "inputResponses": { "review": { "action": "accept", "content": { "confirm": true } } },
  "requestState": "public-native-probe"
}
```

Raw transcripts, drivers, source snapshots and API observations remain in `/tmp/fidy-988-opencode/`.
This report and the normalized observations are durable research artifacts, not a formal repository
suite. Initial `/tmp` versus `/private/tmp` location aliasing was eliminated in later attached-TUI
runs by using the explicit physical directory; a fresh server was started to eliminate old pending
forms. The newly-created-form/live-display problem still reproduced, while reattachment exposed it.

## Source-backed diagnosis

Release-pinned source **does contain** both handler registration and native form conversion:

1. [`McpClient.connect`](https://github.com/anomalyco/opencode/blob/63e33bc4dc7d93ccdfb008908e12e4762f8361b8/packages/core/src/mcp/client.ts#L184-L214)
   advertises form capability and registers `elicitation/create`. It runs the callback through
   **`Effect.runPromise(...)`**, unlike its logging callback, which uses a context-capturing runner.
2. [MCP form owner](https://github.com/anomalyco/opencode/blob/63e33bc4dc7d93ccdfb008908e12e4762f8361b8/packages/core/src/mcp/index.ts#L231-L295)
   converts the requested schema into a `Form.Service.ask` under session `global`, and maps answered
   state to `accept`/content or dismissal to `cancel`. The backend API observation confirms it ran.
3. [`Form.create`](https://github.com/anomalyco/opencode/blob/63e33bc4dc7d93ccdfb008908e12e4762f8361b8/packages/core/src/form.ts#L124-L154)
   publishes `form.created` through the Bus without explicit location options.
4. [`Bus.publish`](https://github.com/anomalyco/opencode/blob/63e33bc4dc7d93ccdfb008908e12e4762f8361b8/packages/core/src/bus.ts#L507-L526)
   obtains event location from the executing Effect context's `Location.Service`, unless explicitly
   supplied. A plain new `runPromise` does not inherit the caller's services.
5. [Solid client event projection](https://github.com/anomalyco/opencode/blob/63e33bc4dc7d93ccdfb008908e12e4762f8361b8/packages/client/src/solid/data.ts#L1205-L1245)
   discards events without `event.location` before handling `form.created`.
   [Its initial location synchronization](https://github.com/anomalyco/opencode/blob/63e33bc4dc7d93ccdfb008908e12e4762f8361b8/packages/client/src/solid/data.ts#L1855-L1872)
   separately fetches global forms, consistent with the dialog appearing after reconnect.
6. [TUI session route](https://github.com/anomalyco/opencode/blob/63e33bc4dc7d93ccdfb008908e12e4762f8361b8/packages/tui/src/routes/session/index.tsx#L201-L207)
   explicitly includes global forms for the current location; its native
   [form widget](https://github.com/anomalyco/opencode/blob/63e33bc4dc7d93ccdfb008908e12e4762f8361b8/packages/tui/src/routes/session/form.tsx#L269-L290)
   submits through the existing form reply API.

**Probable cause:** the SDK callback loses the location context, so form creation succeeds but its
live event lacks the location the UI requires. **Not yet a patched-and-verified root cause**: this
research did not modify/rebuild OpenCode or capture the raw live bus envelope. Preserve the originating
location context in elicitation callbacks, or explicitly publish the correct location, then test
new-form arrival and cancel/reply events in the active TUI as the upstream fix candidate. Avoid a
UI polling/reconnect workaround or pretending capability advertisement proves working UX.

## Resolving potentially misleading external evidence

[OpenCode issue #51856](https://github.com/anomalyco/opencode/issues/51856) remains open and reports
2.0.18 advertising forms while requests hang. It is corroborating **older reporter evidence**, not
authoritative proof of this release's implementation. Its claim that the handler is absent does not
match the pinned **2.0.23** source or our observed backend form creation.

[ACP documentation](https://opencode.ai/v2/docs/cli/acp/) describes OpenCode sending elicitation to an
ACP host. That is the opposite protocol role and does **not** prove support for an MCP server
requesting confirmation inside OpenCode. This investigation checked the actual MCP-client path.

[Official v2 MCP docs](https://opencode.ai/v2/docs/mcp-servers), “Protocol version”, “Permissions” and
“Timeouts”, support the configuration used: legacy default, explicit auto/modern negotiation,
direct versus Code Mode exposure, and ordinary local tool permissions. Its 12-hour default execution
timeout is not a suitable Fidy confirmation lifetime; server-side bounded pending work still applies.
[Custom provider docs](https://opencode.ai/v2/docs/providers#custom) and
[model capability docs](https://opencode.ai/v2/docs/models#aliases) describe the canned provider seam.

## Updated support proposal

| Intended host       | Native exact-action interaction status                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Claude Code 2.1.289 | Clean synthetic native accept/cancel journeys demonstrated                                      |
| Codex 0.160.0       | Clean synthetic native accept/cancel journeys demonstrated with default protocol                |
| Pi 1.0.3            | Dedicated adapter extension is now an accepted installation option; not built or certified yet  |
| OpenCode v2.0.23    | Native implementation exists, but newly requested TUI form delivery needs a fix and clean rerun |

For OpenCode, pursue the focused upstream context/event-delivery fix and verify a released/pinned
working build. Do not make reconnecting part of Fidy's supported experience. No OpenCode plugin has
been shown necessary once its existing native path works correctly.

For Pi, proceed only with an explicitly scoped adapter prototype/implementation under the existing
standards; installation approval removes the previous no-plugin preference, not the obligation to
verify OAuth, UI cancellation, non-UI refusal and the exact server-owned form flow. No Pi extension
was implemented by this research.

The common security distinction is unchanged: native replies, including a Fidy-authored Pi adapter's
reply, are **client-asserted approval**, not independent same-User first-party proof. #988, ADR 0033
and the security policy still require an explicit authority decision before implementation can use
native acceptance to authorize sensitive mutation. This report does not approve weakening that rule.

## Unresolved / not authorized

A clean OpenCode live form/accept/resume and cancellation journey, the probable upstream fix, Pi's
adapter, real canonical/Core/D1 atomic consumption and batch rollback, real OAuth authority checks,
human-driven final Spanish UI, and slow/disconnected host behavior remain open. Desktop, web, mini,
ACP and production Code Mode were not certified. No production change, upstream issue/PR submission,
deployment, onboarding or launch enablement was performed or authorized by this investigation.
