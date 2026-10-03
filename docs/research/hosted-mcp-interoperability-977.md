# Hosted MCP interoperability — #977

## Result and scope

Recorded 2026-10-03 against checkout `00f50e621c353d01d30781d2a00c77314394ace2`.
This is a disposable local compatibility investigation for
[#977](https://github.com/B4rz99/fidy-ai/issues/977), governed by the live body and latest scope
comment of [#33](https://github.com/B4rz99/fidy-ai/issues/33). It implements no production OAuth,
canonical caller or web UI. The [accepted successor ADR](../adr/0033-hosted-mcp-and-oauth-agent-grants.md)
records downstream ownership and security design; it does not certify launch interoperability.

**The exact-host matrix is not green.** Pi completed synthetic browser exchange, refresh and
legacy discovery. Codex refused the callback with required issuer validation. Claude completed
synthetic browser exchange but later health/reconnect reported authentication needed. No actual
Fidy sign-in, financial query/mutation, revocation, or sensitive-operation approval was tested.
Production deployment, real Users/providers and onboarding remain unauthorized. Do not close the
parent host acceptance gate using this report.

## Versions and source provenance

| Component               | Exact version / evidence                                               |
| ----------------------- | ---------------------------------------------------------------------- |
| Claude Code             | `2.1.288`, installed only in `/tmp/fidy-977-spike`; `claude --version` |
| Codex                   | `codex-cli 0.144.1`, installed executable; `codex --version`           |
| Pi                      | `1.0.0`, `@earendil-works/pi-coding-agent`; `pi --version`             |
| Bun                     | `1.4.1`                                                                |
| Protocol fixture        | `effect@4.0.0`, isolated install; **not** root rc.115                  |
| MCP revisions exercised | `2026-07-28` directly; Pi negotiated `2025-11-25`                      |

The npm `effect@4.0.0` tarball integrity observed via `npm view effect@4.0.0 dist.integrity`:
`sha512-ooc1TG5t+FfzgYnFz2ff6BBKyZ7EwBRVXC7c4RhQUAD6/TZ2gTXXMeb4WX7a19ozQo4J73/QW+S00YAIresoMQ==`.
The fixture manifest pins stable Effect without modifying the production Effect family. Stable
imports use `effect/ai` and `effect/http`; the repository still uses rc.115 unstable namespaces.

Primary sources retrieved for this investigation:

1. [Effect 4.0.0 McpProtocol source](https://unpkg.com/effect@4.0.0/src/ai/McpProtocol.ts),
   lines 13–28, 182–247: dated protocol adapters, stateless 2026 and older stateful profiles.
2. [Effect 4.0.0 McpServer source](https://unpkg.com/effect@4.0.0/src/ai/McpServer.ts),
   lines 1490–1635: single endpoint HTTP, Origin/Accept/media policy, public `layerHttp`;
   [HttpRouter](https://unpkg.com/effect@4.0.0/src/http/HttpRouter.ts), lines 1417–1482:
   public web handler and disposal. Source was inspected from the exact isolated install.
3. [MCP 2026-07-28 Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http):
   transport policy, required version/method metadata, stateless request lifecycle.
4. [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization):
   protected-resource discovery, PKCE/resource binding, issuer response validation, scope selection,
   refresh and step-up policy. [Client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
   prefers CIMD and retains DCR only for compatibility.
5. [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp), sections
   “MCP client runtimes”, “Authenticate with remote MCP servers”, “Use pre-configured OAuth
   credentials”, “Respond to MCP elicitation requests”: v2 supports 2026, CIMD discovery,
   loopback callbacks, refresh and URL elicitation. This is current documentation, not proof that
   every advertised behavior succeeded in the installed host.
6. [Codex MCP documentation](https://developers.openai.com/codex/mcp): Streamable HTTP configuration,
   OAuth login and scopes; exact-version source
   [oauth.rs](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/rmcp-client/src/oauth.rs) and
   [perform_oauth_login.rs](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/rmcp-client/src/perform_oauth_login.rs).
   Do not infer successful issuer handling from those declarations.
7. Pi installed `docs/mcp.md`, sections “Authenticate with OAuth”, “Use resources”, “Permissions”,
   in `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`: DCR/public client configuration,
   issuer discovery, loopback callbacks, refresh, no MCP Apps rendering, no automatic tool-call
   retry. Upstream owner: [earendil-works/pi](https://github.com/earendil-works/pi),
   `packages/coding-agent/docs/mcp.md`. Installed `dist/extensions/mcp/oauth.js` lines 180–240
   serialize refresh; lines 310–344 forward callback issuer to the OAuth library. This installed
   1.0.0 evidence is version-specific; mutable upstream main is not its version pin.

## Actual observations versus simulation

The MCP wire implementation was **Effect**, not another MCP SDK or copied JSON-RPC handlers.
HTTP requests in the test are client probes; they do not implement a replacement MCP server.
The OAuth fixture deliberately simulates registration, approval and token issuance separately.
It serves loopback HTTP, automatically approves GET `/authorize` and contains no real User,
WebSession, Consent, D1, canonical operation or provider. An OS browser followed that fixture's
redirect; it did not sign in to Fidy. Token/code values remained only in disposable local profiles
and memory. Raw login logs/URLs and credential files are not checked in.

| Behavior                              | Claude Code 2.1.288                                               | Codex 0.144.1                                                            | Pi 1.0.0                                                                                |
| ------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Add HTTP URL                          | Actual CLI configuration success                                  | Actual CLI configuration success                                         | Actual CLI configuration success                                                        |
| Protected-resource / issuer discovery | Observed                                                          | Observed                                                                 | Observed                                                                                |
| Registration                          | DCR, claimed name `Claude Code (spike)`                           | DCR, claimed name `Codex`                                                | DCR, claimed name `pi`                                                                  |
| Callback                              | `http://localhost:56676/callback`                                 | `http://127.0.0.1:61068/callback/79JJnKJcmDd_`                           | `http://127.0.0.1:61100/callback`                                                       |
| PKCE S256 / authorization resource    | Observed                                                          | Observed                                                                 | Observed                                                                                |
| PKCE verifier / token resource        | Fixture checked both successfully                                 | Never reached token exchange                                             | Fixture checked both successfully                                                       |
| Issuer response                       | `iss` emitted; exchange completed; hostile issuer not tested      | **Failed**: required issuer reported missing despite fixture emitting it | `iss` emitted; exchange completed; hostile issuer not tested                            |
| Refresh rotation                      | One synthetic refresh accepted during login; reconnect not proved | Not reached                                                              | Repeated rotated refreshes accepted across login/list processes                         |
| 2026-only discovery                   | Not demonstrated                                                  | Not reached                                                              | Failed: legacy `initialize` omitted required version header                             |
| 2025-11-25 compatibility              | Reconnect returned “Needs authentication”; not proved             | Not reached                                                              | `initialize`, `notifications/initialized`, `mcp list --json` connected with empty tools |
| CIMD preference                       | Documented, **not exercised**                                     | **Not exercised**                                                        | **Not exercised**; DCR observed                                                         |
| Browser sensitive handoff/resume      | Documented URL elicitation, **not exercised**                     | **Not exercised**                                                        | **Not exercised**                                                                       |

Ports vary by run; callback paths in the observations are routing metadata, not approval authority.
The empty tool catalog intentionally prevents any domain work. It proves connection/discovery only,
not canonical schema projection or tool execution. Some Pi discovery requests were batched; the
fixture's single-method observation is absent for those arrays, so do not infer which methods ran
from that field alone. Pi's CLI `connected`/empty-tools result is the outcome evidence.

### Failures worth preserving

- Codex's automatic OAuth flow ran twice (`mcp add` starts login itself, followed by explicit
  `mcp login`). Both rejected with `Authorization server response missing required issuer:
expected http://127.0.0.1:19770`. The fixture emits `iss` and advertises
  `authorization_response_iss_parameter_supported: true`. Root cause is **not established**;
  inspect exact callback transport and upstream source in the next focused reproduction. Do not
  silently set the advertisement false, omit issuer validation or claim issuer interoperability.
- Pi reached token exchange against a 2026-only Effect server, then failed with HTTP 400,
  `MCP-Protocol-Version header is required`. Adding Effect's 2025-11-25 adapter allowed its observed
  initialization profile and subsequent connected list. This is the only demonstrated older
  adapter requirement. No 2024-11-05, 2025-03-26 or 2025-06-18 launch adapter is justified.
- Claude login requires a terminal. A non-TTY attempt explicitly refused; a PTY run returned
  `Authenticated with "spike"`. Later `mcp list` returned “Needs authentication”. The artificially
  short three-second token window and host storage/reconnect path need isolation before attributing
  this to a host defect. No stateless Claude discovery success is claimed.
- Restarting the in-memory simulator invalidated saved registration/refresh state. Pi correctly
  requested authorization again; deleting **only the disposable** Pi credential file and redoing
  registration restored the synthetic journey. This is fixture lifecycle, not production durability.

## Protocol seam: red → green

`server.test.md` records a focused executable seam test. First run failed because the fixture module
was absent. After adding Effect's handler, probes exposed required request metadata and `Mcp-Method`
validation. The final independent expected result is HTTP 200 with an empty tools array, without
initialization; a foreign browser Origin returns 403. Final run: **1 pass, 0 fail, 3 assertions**.

This is not OAuth negative/security evidence. The synthetic OAuth fixture is intentionally not
production validated; neither its maps nor automatic approval can become production authority.
Downstream security tests must cover all parent negative cases at real ingress/Core/D1 seams.

## Reproduction

Artifacts are in [hosted-mcp-spike/](hosted-mcp-spike/). Executable snippets are Markdown deliberately:
they use stable-only imports and an isolated dependency/runtime, not the rc.115 workspace. No root
lint exclusion or suppression is needed. Extract their single JavaScript fence into the named files:

````bash
scratch=$(mktemp -d)
cp docs/research/hosted-mcp-spike/package.json "$scratch/"
python3 - "$scratch" <<'PY'
from pathlib import Path
import sys
root = Path('docs/research/hosted-mcp-spike')
for source, output in [('server.md', 'server.mjs'), ('server.test.md', 'server.test.mjs'), ('oauth.md', 'oauth.mjs')]:
    text = (root / source).read_text()
    Path(sys.argv[1], output).write_text(text.split('```js\n', 1)[1].split('\n```', 1)[0] + '\n')
PY
cd "$scratch"
bun install
bun test server.test.mjs
bun oauth.mjs --synthetic                 # 2026 only; loopback 19770
# Stop fixture before switching:
bun oauth.mjs --synthetic --legacy        # 2026 + 2025-11-25
````

Use isolated homes, never existing credentials. Install Claude only into the scratch package:

```bash
bun add --exact @anthropic-ai/claude-code@2.1.288
mkdir -p homes/pi homes/codex homes/claude
HOME="$PWD/homes/pi" PI_CODING_AGENT_DIR="$PWD/homes/pi/agent" \
  pi mcp add spike --url http://127.0.0.1:19770/mcp
HOME="$PWD/homes/pi" PI_CODING_AGENT_DIR="$PWD/homes/pi/agent" \
  pi mcp login spike --timeout 15
HOME="$PWD/homes/pi" PI_CODING_AGENT_DIR="$PWD/homes/pi/agent" pi mcp list --json
CODEX_HOME="$PWD/homes/codex" codex mcp add spike --url http://127.0.0.1:19770/mcp
CODEX_HOME="$PWD/homes/codex" codex mcp login spike
CLAUDE_CONFIG_DIR="$PWD/homes/claude" DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 \
  ./node_modules/.bin/claude mcp add --transport http spike http://127.0.0.1:19770/mcp
# Run in a terminal, not redirected stdin:
CLAUDE_CONFIG_DIR="$PWD/homes/claude" DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 \
  ./node_modules/.bin/claude mcp login spike
CLAUDE_CONFIG_DIR="$PWD/homes/claude" DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 \
  ./node_modules/.bin/claude mcp list
curl http://127.0.0.1:19770/evidence
```

These commands do not invoke a model. Use the browser opened by the hosts, or open the transient
printed authorization URL locally. Do not paste callback/token material into issue comments or
commit logs. Stop the simulator, remove the scratch profiles, and close fixture browser tabs after
capturing only safe observations. Checked-in `evidence-stateless.json` and `evidence-legacy.json`
are ordered, credential-free fixture observations, not security/audit evidence. Registrations were
DCR-only because the fixture advertised only DCR; this does **not** establish lack of CIMD support.

## Registration and downstream decisions

The standards prefer CIMD; the current fixture demonstrates DCR fallback, not preference selection.
Use CIMD only after fetching the actual host-owned metadata with bounded/SSRF-safe policy and
proving each exact host selects it. Retain bounded public DCR for Pi/Codex unless reruns establish
CIMD support. Display all client names as unverified claims. Pre-registration is standards compliant
but adds manual setup and cannot replace the requested primary experience. Arbitrary metadata URL
fetching, wildcard redirects and unbounded dynamic registration are unacceptable compatibility fixes.
The ADR fixes byte/deadline/concurrency/cache/registration bounds and requires fail-closed fetching
when DNS destination safety cannot be enforced.

## Unresolved acceptance evidence

1. Resolve Codex issuer callback rejection; prove token exchange, refresh and MCP discovery without
   weakening issuer/resource binding. Record its actual protocol revision, not SDK assumptions.
2. Isolate Claude reconnect with a realistic ten-minute access window; prove stateless discovery,
   refresh across processes and runtime selection. Documentation alone is insufficient.
3. Exercise CIMD preference and metadata-fetch/redirect negatives for all three hosts. Current DCR
   evidence is real host traffic against simulated registration, not a registration security review.
4. Exercise URL-elicitation handoff/resume for exact hosts. Until then all sensitive interactions are
   unsupported and fail closed, as the ADR specifies. No host/model confirmation is authority.
5. Build real browser approval, OAuth caller/access algebra and authority only in downstream tickets,
   then test current Consent, exact scopes, atomic code/refresh rotation, replay/concurrency, separate
   revocation, shared User allowance and attributable Audit. Never infer these from this simulator.

The report therefore records a **partially validated approach with explicit blockers**, not a complete
successful three-host proof. #35 and explicit operator approval remain launch gates.
