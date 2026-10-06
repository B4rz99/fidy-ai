# Hosted MCP interoperability — #977

## Result and scope

Recorded 2026-10-03 for [#977](https://github.com/B4rz99/fidy-ai/issues/977), under the live body and
latest scope comment of [#33](https://github.com/B4rz99/fidy-ai/issues/33). This is a disposable
protocol/browser-exchange investigation, **not production OAuth or a security certification**.
The [successor ADR](../adr/0033-hosted-mcp-and-oauth-agent-grants.md) owns the accepted downstream
design. No production deployment, real Fidy User/session, financial work, provider/model invocation,
onboarding or launch enablement occurred.

**The revised two-host compatibility slice passes.** Claude Code 2.1.288 uses stateless
2026-07-28 and CIMD; Codex 0.160.0 uses 2025-11-25 and CIMD.
All completed the synthetic browser exchange with S256 and resource binding, reconnected using
rotated refresh credentials twice in separate processes, and rejected substituted callback issuers
before token exchange. Claude's CLI health probe exercises `server/discover`; Codex's real app
server exercises legacy initialization/discovery. This is not proof of canonical
queries/mutations, real browser consent, atomic refresh security, or sensitive-operation execution.

The earlier `d905ab38f9` checkpoint was incomplete. Its observations remain in
`evidence-stateless.json` and `evidence-legacy.json`; they do not describe the revised launch matrix.
Continuation evidence and source inspection resolved its two Spec findings rather than weakening
issuer policy. Sensitive handoff is specified in ADR 0033 but remains **unsupported for every host
until its downstream browser/host implementation is tested**; annotations or SDK capabilities are
not certification.

## Exact versions and primary sources

| Component   | Revised tested version     | Evidence                                                                 |
| ----------- | -------------------------- | ------------------------------------------------------------------------ |
| Claude Code | `2.1.288`                  | isolated npm installation, `claude --version`                            |
| Codex       | `0.160.0`                  | isolated `@openai/codex`, `codex --version`; supersedes rejected 0.144.1 |
| Effect      | `4.0.0`                    | exact isolated manifest; production workspace stays rc.115               |
| Bun         | `1.4.1`                    | `bun --version`                                                          |
| Protocols   | `2026-07-28`, `2025-11-25` | actual Effect request observations below                                 |

The npm `effect@4.0.0` integrity observed through `npm view effect@4.0.0 dist.integrity`:
`sha512-ooc1TG5t+FfzgYnFz2ff6BBKyZ7EwBRVXC7c4RhQUAD6/TZ2gTXXMeb4WX7a19ozQo4J73/QW+S00YAIresoMQ==`.
Host packages and Effect are pinned in `hosted-mcp-spike/package.json`. Only the disposable
installation changes; a production Effect-family upgrade remains downstream work.

Primary sources checked:

1. [Effect 4.0.0 McpProtocol](https://unpkg.com/effect@4.0.0/src/ai/McpProtocol.ts), lines 13–28,
   182–247: stateless 2026 and older stateful adapters;
   [McpServer](https://unpkg.com/effect@4.0.0/src/ai/McpServer.ts), lines 1490–1635: HTTP transport,
   Origin/Accept/media policy and `layerHttp`;
   [HttpRouter](https://unpkg.com/effect@4.0.0/src/http/HttpRouter.ts), lines 1417–1482:
   public web handler/disposal. Exact installed sources were inspected, not rc.115 API memory.
2. [MCP 2026 transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
   [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization),
   [registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration):
   stateless request metadata, issuer/resource validation, CIMD preference and DCR compatibility.
3. [Claude Code documentation](https://code.claude.com/docs/en/mcp), “MCP client runtimes”,
   “Authenticate with remote MCP servers”, “Use pre-configured OAuth credentials”, “Respond to MCP
   elicitation requests”: v2/stateless, CIMD, loopback callbacks, refresh and URL elicitation.
   These are sourced capabilities, not substitutes for actual observations.
4. [Codex 0.144.1 callback source](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/rmcp-client/src/perform_oauth_login.rs#L306-L362):
   callback retains code/state but discards `iss`.
   [Codex 0.160.0 source](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/rmcp-client/src/perform_oauth_login.rs#L369-L401)
   retains issuer; [lines 776–786](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/rmcp-client/src/perform_oauth_login.rs#L776-L786)
   call `handle_callback_with_issuer`. [Codex MCP docs](https://developers.openai.com/codex/mcp)
   document HTTP/OAuth. The model-free host probe uses the installed binary's generated public
   `ClientRequest.json`: `initialize`, `initialized`, `mcpServerStatus/list`. It drives Codex's
   real MCP client; it does not replace it or invoke a model.
5. Actual host-owned CIMD documents retrieved in this continuation:
   [Codex](https://chatgpt.com/oauth/codex/client.json),
   [Claude Code](https://claude.ai/oauth/claude-code-client-metadata).
   Both name themselves as public clients, permit authorization_code/refresh_token and register
   `http://localhost/callback` and `http://127.0.0.1/callback`. The checked-in
   `client-metadata.json` records their reviewed redirect projection. Port variation is the native
   RFC 8252 exception, not a wildcard path. The simulator uses those operator-supplied projections;
   it does not implement production CIMD fetching.

## Revised actual-host matrix

| Behavior                                  | Claude Code 2.1.288                                    | Codex 0.160.0                                          |
| ----------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| Add URL / synthetic browser exchange      | Pass                                                   | Pass                                                   |
| Protected-resource and issuer discovery   | Observed                                               | Observed                                               |
| Registration with CIMD and DCR advertised | **CIMD**, Claude-hosted URL                            | **CIMD**, Codex-hosted URL                             |
| Redirect handling                         | localhost callback; exact path, variable loopback port | 127.0.0.1 callback; exact path, variable loopback port |
| S256 authorization / verifier             | Fixture checks pass                                    | Fixture checks pass                                    |
| Resource in authorization/code/refresh    | Bound at all three seams                               | Bound at all three seams                               |
| Wrong callback issuer                     | Host rejects; no code exchange                         | Host rejects; no code exchange                         |
| Selected protocol                         | **2026-07-28**, `server/discover`                      | **2025-11-25**, initialized discovery                  |
| 2026-only server                          | Stateless discovery passes                             | Startup fails with required-header refusal             |
| Forced expiry → rotated refresh/reconnect | Two separate process runs pass                         | Two separate process runs pass                         |
| Sensitive-operation handoff/resume        | Not certified; fail closed                             | Not certified; fail closed                             |

`host-outcomes.json` groups each host's two forced-expiry runs with its own safe event delta and
caller-visible outcome. `evidence-resolved.json` retains the positive setup sequence;
`evidence-wrong-issuer.json` contains hostile callbacks and **zero code exchanges**;
`evidence-strict.json` records actual Codex initialization rejection by the 2026-only server.
Only Effect's **2025-11-25** adapter is necessary compatibility. There is no evidence requiring
2024-11-05, 2025-03-26 or 2025-06-18; do not add them speculatively.

No server notifications, SSE event resumption, MCP Apps, financial tools or application-wide
protocol support are promised. Effect returns 405 for legacy clients' optional GET SSE probes;
observed clients nevertheless completed POST discovery. Claude's health command probes server discovery,
not a financial tool call. The empty catalog prevents all domain work by construction.

## Diagnoses and controlled fixes

### Codex issuer failure

0.144.1's callback parser drops `iss` before the OAuth manager sees it. The original simulator
already emitted `iss` and advertised issuer support, so the failure was not fixed by weakening
metadata. 0.160.0 retains and validates it. The revised host completed exchange, and the separate
wrong-issuer run refused before `/token`. Thus **0.144.1 is unsupported for this connection design**;
0.160.0 is the validated host baseline. This is a version requirement, not a Fidy protocol workaround.

### Claude reconnect failure

With the realistic ten-minute token window, a login using the canonical physical scratch path
`/private/tmp/...` followed by a health command using symlink spelling `/tmp/...` still reported
“Needs authentication”. Keeping the identical physical `CLAUDE_CONFIG_DIR` spelling returned
“Connected” and a 2026 `server/discover` response. The fixture was unchanged during that comparison.
This establishes a local profile-path discrepancy, not a Claude protocol limitation; credential-store
namespace details are inferred, not asserted as inspected proprietary internals.

Use `root=$(pwd -P)` consistently for all profiles. The original three-second expiry was also a bad
fixture default and is replaced by the designed 600 seconds. `/expire-access` is explicit local
fault injection so refresh evidence does not depend on waiting ten minutes or an expiry race.

### CIMD invalid requests

Advertising CIMD caused Claude/Codex to use their HTTPS document URL as client_id instead of DCR.
The first simulator lacked those documents' redirect declarations and correctly refused unknown
redirects. This was an incomplete fixture, not missing Claude installation or a host auth defect.
After retrieving both official documents and supplying exact callback declarations, both exchanged
successfully. Repeated names remain unverified display claims.

## Registration and security conclusions

**Resolved launch registration:** prefer CIMD for the validated Claude/Codex versions. No client secret or manual pre-registration is necessary for these
observed flows. Pre-registration may be troubleshooting, not the primary setup. This result does
not generalize to older/newer hosts.

Production fetch policy is ADR 0033's reviewed-origin/path allowlist, HTTPS-only, no redirects,
16 KiB streamed bytes, three-second deadline, four-way concurrency and bounded cache, with
DNS/private-address/rebinding protection. If safe destination enforcement is unavailable, fail
closed. This simulator deliberately **never fetches arbitrary metadata URLs**; it receives a static
operator-reviewed projection. SSRF/bounded-fetch implementation and negative tests belong to the
future authority adapter, not this automatic-approval fixture. Claims, display names and metadata
cannot grant User ownership.

Issuer/resource/redirect/S256 checks in the fixture distinguish interoperability failures, not a
security certification. The regression test rejects a substituted refresh resource without consuming
its valid credential, then accepts the correct request. Real atomic refresh family revocation,
revoked/expired grants, CSRF, two-User isolation and absence of partial D1 effects remain mandatory
in downstream work. The fixture uses in-memory raw credentials intentionally for disposable
interoperability and must never become a production adapter.

## Sensitive browser handoff and approval design

ADR 0033 specifies the same-User fresh-session approval, requested-only/narrower non-empty scopes,
read-only omitted-scope default, no implicit write, fixed reviewed expiration and distinct revocation
controls. It also specifies pending → approved → atomically consumed OAuthOperationConfirmation,
exact operation/input digest/revisions, connection, expiry, public-only handoff reference,
protocol-metadata resume and whole-batch consumption. A browser approval does not execute a mutation;
model claims, host annotations and elicitation acceptance do not establish evidence.

Both hosts remain **unsupported for sensitive execution until downstream host-facing handoff
and resume tests pass**. Claude documentation of URL elicitation is not proof of exact resume
behavior; Codex protocol capabilities are not confirmation. This ticket specifies that boundary
and its fail-closed behavior rather than introducing untested production confirmation authority.
No extra tool, custom MCP method or secret passed through the model is approved as a fallback.

## Executable evidence and reproduction

Artifacts live in [hosted-mcp-spike/](hosted-mcp-spike/). Snippets are Markdown because stable-only
imports and the disposable runtime are separate from the rc.115 production workspace; no root lint
suppression/exclusion is needed. The focused tests cover stateless discovery/Origin refusal and
realistic exchange/resource refusal. Hosts run model-free: CLI MCP commands and Codex's app-server
status request; no inference turn is started.

````bash
scratch=$(mktemp -d)
cp docs/research/hosted-mcp-spike/package.json "$scratch/"
cp docs/research/hosted-mcp-spike/client-metadata.json "$scratch/"
python3 - "$scratch" <<'PY'
from pathlib import Path
import sys
root = Path('docs/research/hosted-mcp-spike')
for name in ['server', 'server.test', 'oauth', 'oauth.test']:
    text = (root / (name + '.md')).read_text()
    Path(sys.argv[1], name + '.mjs').write_text(text.split('```js\n', 1)[1].split('\n```', 1)[0] + '\n')
text = (root / 'host-probes.md').read_text()
Path(sys.argv[1], 'host-probes.py').write_text(text.split('```python\n', 1)[1].split('\n```', 1)[0] + '\n')
PY
cd "$scratch"
root=$(pwd -P)  # identical profile spelling for every invocation
bun install
bun test server.test.mjs oauth.test.mjs
SPIKE_PORT=19772 SPIKE_METADATA_CLIENTS="$(python3 -c 'import json; print(json.dumps(json.load(open("client-metadata.json"))["redirects"]))')" \
  bun oauth.mjs --synthetic --legacy --cimd
````

In another terminal, with the same physical scratch directory:

```bash
root=$(pwd -P)
mkdir -p homes/claude homes/codex
CLAUDE_CONFIG_DIR="$root/homes/claude" DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 \
  ./node_modules/.bin/claude mcp add --transport http spike http://127.0.0.1:19772/mcp
python3 host-probes.py claude-login homes/claude
CLAUDE_CONFIG_DIR="$root/homes/claude" DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 \
  ./node_modules/.bin/claude mcp list
CODEX_HOME="$root/homes/codex" ./node_modules/.bin/codex mcp add spike --url http://127.0.0.1:19772/mcp
python3 host-probes.py codex-discover homes/codex
curl -X POST http://127.0.0.1:19772/expire-access
# Repeat the two discovery commands; force expiry again and repeat for rotation evidence.
curl http://127.0.0.1:19772/evidence
```

The simulator automatically approves in the opened OS browser; this is **not real sign-in**. Use
only isolated profiles. For hostile issuer evidence, start a new fixture/profile set at port 19773
with the same metadata map and `--wrong-issuer`; both login attempts must reject and evidence
must contain no `code-exchange`. For adapter evidence, use another fixture/profile set at 19774
without `--legacy`; Codex token exchange succeeds but their initialization receives 400. Do not
restart an in-memory fixture under saved credentials and interpret lost registrations as host bugs.

Stop all scratch servers/processes and delete local credential profiles and raw login logs when
finished. Host-probe output and checked-in observations omit codes, PKCE verifiers, bearer/refresh
credentials and authorization URLs. No credential file or raw callback log is committed. Public
CIMD URLs and callback redirect routes are registration metadata, not authority.

## Remaining downstream gates (not missing #977 production work)

The scoped protocol/browser-exchange and registration investigation is complete for the exact
revised versions, with explicit unsupported older versions and sensitive interactions. The following
remain **parent #33 implementation/launch gates**, not achievements of this spike:

- coherent production Effect-family upgrade and canonical OAuth caller/access implementation;
- real fresh-session Spanish approval, connection management and exact confirmation handoff;
- real ingress/Core/D1/coordinator negative tests, User isolation, atomic refresh replay/concurrency,
  live Consent/revocation, private discovery/nested schemas, canonical envelopes and Audit;
- production bounded metadata fetching/admission/observability and cancellation/delivery ambiguity;
- #35's shared User allowance, full verification, synthetic release evidence and operator approval.

Successful local interoperability is not permission to enable real Users or promise every MCP host,
revision, notification feature or sensitive interaction.
