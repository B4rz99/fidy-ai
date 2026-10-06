# Latest-host verification and solution proposal — #988

**Implementation follow-up:** #988 now implements the selected native-form path. See the
[pinned ingress/Core/D1 host evidence](../../scripts/mcp/native-confirmation-hosts.evidence.json).
The research-time limitations below are historical, not the current implementation status;
production onboarding, deployment and launch remain unauthorized.

**Final decision (2026-10-05):** Claude Code/Codex native forms only, with authorized client approval
as the accepted trust boundary. Pi, OpenCode, extensions and browser fallback are excluded. See
[amended ADR 0033](../adr/0033-hosted-mcp-and-oauth-agent-grants.md) and #988; earlier policy blockers below are historical.

**Subsequent direction:** the User prefers native in-session confirmation, not a browser detour.
The [native-form investigation](oauth-native-confirmation-988.md) demonstrates that interaction on
latest Claude and default Codex and identifies its different approval trust boundary. The browser
fallback proposal below remains historical/unapproved, not the selected implementation direction.

Checked **2026-10-05**, beginning at **15:18 UTC**. This follows the
[baseline-only investigation](oauth-confirmation-hosts-988.md), and resolves its missing check of
current published host releases. Research/proposal only: no production code, dependency, ADR,
release configuration, deployment, onboarding or launch enablement was changed.

## Latest published releases verified

“Latest” here means the package publisher's npm **`latest`** tag, not an alpha/beta or a local global
installation. Fresh isolated installs used exact versions. The binaries independently reported:

| Host        | npm `latest` | Binary result           | Publication instant (UTC) |
| ----------- | ------------ | ----------------------- | ------------------------- |
| Claude Code | **2.1.289**  | `2.1.289 (Claude Code)` | 2026-10-03 20:12:02.717   |
| Codex       | **0.160.0**  | `codex-cli 0.160.0`     | 2026-10-01 20:26:19.286   |
| Pi          | **1.0.3**    | `1.0.3`                 | 2026-10-05 08:37:00.736   |

The previous Codex baseline was already the latest normal release, but that was not previously
verified. Claude and Pi had newer releases. Claude also advertised `stable: 2.1.285`; the tested
version is its `latest: 2.1.289`, not that separate rollout tag. Codex advertised
`alpha: 0.162.0-alpha.15`; that prerelease was **not** substituted for the normal release or
runtime-tested. GitHub also identifies `rust-v0.160.0` as Codex's latest non-prerelease.

The server remained **Effect 4.0.0**, the application-selected release. No repository install or
cooldown exception was used: host packages were installed in a disposable scratch directory.

## Latest-version results

| Host/path                               | Observed behavior                                                                                                                                                   | Conclusion                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Claude Code 2.1.289 / 2026-07-28        | URL input reached its hook; independent synthetic review completed; host repeated unchanged arguments with keyed response and public `requestState`; one completion | **Synthetic protocol round-trip passes**                                              |
| Codex 0.160.0 / default 2025-11-25      | URL input reached the app-server client and returned `accept`; no modern keyed continuation                                                                         | **Browser-interaction primitive passes; modern resume is not available on this path** |
| Codex 0.160.0 / experimental 2026-07-28 | Rejects Effect's URL input with `unsupported MCP tool input request`; no review and no completion                                                                   | **Not interoperable as-is**                                                           |
| Pi 1.0.3 / built-in 2025-11-25          | Advertises roots but no elicitation; Effect refuses the interaction; no review and no completion                                                                    | **Native interaction remains unsupported**                                            |

These results repeat the previous limitations using the latest normal releases. **Upgrading the
harnesses alone does not resolve #988.**

### Evidence scope

These are real host protocol/integration probes with **simulated** browser approval, not security
certification for Fidy. The scratch tool had no real User, OAuthConnection, credential, financial
record or mutation. Approval used an independent loopback review request, not an agent claim.

- Claude ran its actual installed CLI with an isolated home, a strict single-server MCP
  configuration, only the probe tool allowed, and the documented Elicitation hook. A loopback
  Messages API returned canned tool/text messages. No model-provider inference was purchased.
- Codex ran its actual installed `app-server --stdio`, an ephemeral thread and public
  `mcpServer/tool/call`. Its app-server client simulated the human approval response. No model
  turn was started. A separate run enabled its under-development `mcp_2026_07_28` feature.
- Pi ran its installed built-in `McpServerConnection` and `createMcpToolDefinition`, invoking
  the actual tool adapter without a model. Its current published source still has no built-in
  elicitation registration or keyed continuation driver.

Native human-operated dialogs, real first-party browser authentication and canonical/Core/D1
mutation execution were not tested. They cannot be certified before the #988 implementation exists.

## The concrete problems

### Codex: modern URL input schema mismatch

Effect's 2026 adapter emits URL input with `mode`, `message` and `url`. The current MCP
specification defines those URL fields. Codex's selected RMCP 3.2.0 parser still requires the
older `elicitationId` field. Consequently its experimental modern continuation fails before the
user sees the approval prompt.

The [baseline diagnostic](oauth-confirmation-hosts-988.md#codex-failure-diagnosis) isolated this:
adding that field to a disposable response let the exact same Codex version complete the keyed
continuation. That was diagnostic evidence, not an approved server patch. The latest normal Codex
is the same version, and its unmodified-server failure was rerun here.

An upstream parser fix, or a deliberately reviewed library-level compatibility change, could fix
that modern path. It would **not** give Pi the missing interaction, and Codex's modern feature is
still experimental. A hand-written Fidy response rewrite is not the recommended solution.

### Pi: no native approval interaction

Latest Pi 1.0.3 still does not advertise elicitation. Its built-in integration supports ordinary
MCP calls, but cannot present this native URL-input workflow. This is a Pi software capability gap,
not something a Fidy User did incorrectly.

Requiring a Pi plugin or custom model tool would add a setup burden and contradict the accepted
connection experience. Waiting for Pi upstream is an option, but not a Fidy-controlled schedule.

### Design dependency: explicit reference echo

ADR 0033 currently requires the host to repeat the invocation with a public continuation reference
in protocol metadata. The modern standard actually uses **top-level `requestState` and
`inputResponses`**. Ordinary Pi calls do not echo such a reference, and default Codex uses the
legacy protocol. Fidy cannot simply assume either host generates custom `_meta`.

## Recommended solution: a first-class browser-link + explicit-repeat path

**Proposal, requiring approval of an ADR/spec amendment before implementation.** Preserve all
confirmation authority rules, but do not require native elicitation or host-generated metadata for
the base experience. Use ordinary canonical/MCP outcomes and ordinary canonical calls:

1. An authorized sensitive request validates its canonical input and domain revision, then
   creates or reuses one bounded pending OAuthOperationConfirmation. **It does not mutate.**
2. Return truthful `user_action_required` through the normal canonical failure envelope, with a
   public first-party review URL and an instruction to explicitly repeat the same operation after
   approval. The URL contains only the public reference, never inputs, credentials or proof.
3. The User follows the link, signs in if needed, reviews the server-owned exact effect in Spanish,
   and chooses **Confirmar / Cancelar**. Fresh same-User authority, Origin/CSRF, live connection,
   scope and Consent checks remain mandatory. Approval alone does not execute the mutation.
4. The User returns to their agent and explicitly asks it to continue. It repeats the **same
   canonical operation and inputs**. No new tool, plugin, token copying or special client setting
   is needed. This is an intentional continuation, not an automatic retry after uncertain delivery.
5. Fidy finds the **single exact matching approved intent** by stable User, OAuthConnection,
   canonical operation, canonical encoded-input digest, entire ordered batch where applicable,
   applicable revisions and original short expiry. Missing, multiple/ambiguous, changed, expired,
   declined or consumed evidence refuses. The agent saying “approved” grants no authority.
6. Consume that evidence atomically with the protected mutation, live authority, domain guards and
   Audit. If the commit fails, it cannot consume approval or partially mutate. Replays do not
   reuse evidence; uncertain delivery is not automatic replay authority.

The explicit change is **server-side exact matching instead of requiring a public reference on the
resumed tool request**. A public reference was never a credential; removing its echo requirement
must not remove any authority binding. The canonical digest, immutable review and atomic proof
consumption still provide those bindings.

### Ambiguity and resource policy

- Permit at most one outstanding intent for the exact User/connection/operation/input/revision
  fingerprint. Repeated unapproved attempts reuse it without extending expiry or duplicating
  pending work. Never select merely by operation name or “latest approval”.
- Keep ADR 0033's five-minute maximum usable lifetime and five outstanding intents per User.
  A changed input, revision or ordered batch requires new visible review, not approval transfer.
- Expiry/decline/consumption and credential/Consent revocation are not reset by another tool call.
  Resolve consumed/outcome-unknown cases truthfully; any new request cannot silently reuse proof.
- Pending input retention is private, bounded and purpose-limited; durable evidence and telemetry
  remain metadata-only. No long-running HTTP request or background polling loop waits for approval.
- Ordinary authorized mutations retain their existing no-repeated-approval behavior.

This proposal gives the User the **same necessary action in every harness**: click a Fidy link,
review, approve, and ask the agent to continue. They do **not** install anything or configure a
workaround. The minor additional “continue” step replaces dependence on unsupported native UI.

A native modern URL interaction can later be a progressive enhancement for independently verified
hosts, invoking the same confirmation owner. It must not become another authority model or a second
operation registry. The base path should not require Codex experimental settings or a Pi extension.

### Fallback transport feasibility checked

A second disposable probe returned an ordinary error result containing the public review URL,
then independently recorded simulated approval. Its inert owner accepted only an exact repeat.
Latest default Codex and latest Pi invoked this through their **actual ordinary tool adapters**.
Both produced this sequence:

| Explicit call                                       | Result                         |
| --------------------------------------------------- | ------------------------------ |
| Original call, before approval                      | Action required; no completion |
| Same call again, still before approval              | Action required; no completion |
| Changed input, after independent simulated approval | Rejected; no completion        |
| Exact original input, after approval                | One synthetic completion       |
| Replay                                              | Rejected; no second completion |

Both had five invocations and exactly one synthetic completion. Neither used elicitation,
experimental protocol configuration, custom request metadata, a plugin or a model approval claim.
This checks **transport feasibility only**. The in-memory probe's JSON comparison and approval flag
are not production cryptography, ownership checks, persistence, or atomicity, and must not become
Fidy's implementation. Production behavior must use canonical decoding/digests and real D1 guards.
Claude's ordinary canonical calls already work; its explicit-repeat UX was not separately replayed
in this follow-up. Its latest native keyed round-trip was replayed as shown above.

## Implementation/verification plan if the proposal is approved

1. Amend ADR 0033 and #988's handoff contract to name the default explicit-repeat path and its
   exact-match/ambiguity policy. Correct “protocol metadata” to standard `requestState` for the
   optional modern path. Do not silently implement an unapproved alternative.
2. Build the OAuth confirmation owner and browser-safe review/decision interface. Derive sensitive
   policy and browser disclosures from canonical metadata; reuse existing fresh-session and CSRF
   policy. Keep all mutation behavior at the existing canonical execution seam.
3. Add first-party review presentation in `oauth-connections`, with clear pending, approved,
   cancelled, expired and completed/unknown outcomes; no credential in browser state or URLs.
4. Prove at real ingress/Core/D1/coordinator seams: same User/connection/operation/input/revision,
   live credential/scope/Consent, expiry/decline/replay/concurrency, no incorrect consumption on
   failed commits, and whole ordered-batch rollback. Keep independent PAT and hosted behavior.
5. Replay the latest-host manual journeys with real canonical execution, human/browser interaction,
   cancellation, delayed approval, changed input/revision and ambiguous delivery. Only then claim
   host support. No deployment or real-user launch is authorized by this proposal.

**If the amendment is not approved:** keep the existing fail-closed rule. Implement only independently
verified native host paths; refuse unsupported sensitive calls; pursue Codex/Pi upstream support.
Do not bypass confirmation to satisfy the host matrix.

## Primary-source references

- Publisher-owned npm metadata, checked live with `npm view <package> dist-tags --json` and
  `npm view <package> time --json`:
  [Claude package](https://registry.npmjs.org/@anthropic-ai%2fclaude-code),
  [Codex package](https://registry.npmjs.org/@openai%2fcodex),
  [Pi package](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent).
  Tags are mutable; the exact versions, publication instants and tested binary versions are
  recorded above. Installed package integrity:
  - Claude 2.1.289: `sha512-RQWjAlalf9aomgI3JaXDCdFPvmNVnRdjwMtYk5L+Lw1NWxCxbhY5T9F+w1xukqvJh/I2rR2+3hICZxhk0al1nA==`
  - Codex 0.160.0: `sha512-kEtVGzjRAYAMOwJxN39bGcna7LT3IDQgq64NNJ/dDTfu4OzZaocJcyNb5/gGJ/IVF/Vj7oK7E2m3nmTan7lpjg==`
  - Pi 1.0.3: `sha512-t2lb0dw4y/jr5a2PRo6eTHGTZOPB3/YAMVyhhYFC1W3Hl5xE+462I/gMWjF4gCLuhGipNEfuNqONFmdqLFz4SQ==`
- [Codex latest normal GitHub release](https://github.com/openai/codex/releases/tag/rust-v0.160.0).
- [MCP 2026 elicitation specification](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation),
  “URL Mode Elicitation Requests”: `accept` is not completion, and the server rechecks independent
  out-of-band state when the original request is repeated.
- [Claude native elicitation documentation](https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests)
  and [Elicitation hooks](https://code.claude.com/docs/en/hooks#elicitation): declared support and
  the automation seam used in the synthetic CLI probe.
- [Pi 1.0.3 connection runtime](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.3/dist/extensions/mcp/runtime.js),
  lines 290–320, and [tool adapter](https://unpkg.com/@earendil-works/pi-coding-agent@1.0.3/dist/extensions/mcp/tools.js),
  lines 203–216: ordinary calls, roots/notifications registration, no elicitation handler.
  [Pi MCP 1.0.3 client](https://unpkg.com/@earendil-works/pi-mcp@1.0.3/dist/client.js),
  lines 234–236: ordinary `tools/call` execution.
- [Codex 0.160.0 continuation parser](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/rmcp-client/src/tool_input.rs#L76-L110),
  lines 76–110 and 167–201, and
  [tool execution](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/rmcp-client/src/rmcp_client.rs#L864-L899):
  modern-only continuation and observed unsupported-input failure. RMCP version/schema citations
  and the controlled diagnostic are in the [baseline report](oauth-confirmation-hosts-988.md#codex-failure-diagnosis).
- [ADR 0033](../adr/0033-hosted-mcp-and-oauth-agent-grants.md#sensitive-operation-handoff-and-resume),
  [#988](https://github.com/B4rz99/fidy-ai/issues/988), and
  [`SECURITY_STANDARDS.md`](../../SECURITY_STANDARDS.md): existing exact confirmation, live authority,
  atomic consumption and unsupported-interaction obligations. The proposal does not amend them
  by itself.

## Remaining limits

This is a supported proposal, not implementation completion. Real browser/Core/D1 behavior,
security review, human-operated host UX and launch evidence remain open. The alpha Codex release
was not runtime-tested. Native capability advertisement is not proof of full approval UX.
