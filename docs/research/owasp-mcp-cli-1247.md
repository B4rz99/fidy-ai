# OWASP MCP and CLI security review

Reviewed 2026-10-13 against trunk `8d57b9f42`, with the ingress hardening in #1247.
This is a source and local-test assessment of installed behavior, not OWASP certification,
a production penetration test, or hosted MCP launch approval.

## Guidance and scope

OWASP publishes [MCP Security guidance](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html)
and an [MCP Top 10](https://owasp.org/projects/mcp-top-10). Relevant measures include
least privilege, schema validation, transport authentication, Origin/Host checks, resource bounds,
sensitive-action approval, tool integrity, isolation, and safe audit evidence.
For the CLI, [OS Command Injection Defense](https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html)
recommends avoiding command interpreters, separating executable arguments, and validating inputs.
[Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
covers credential access, lifetime, revocation, and transport protection.

Fidy supplies a hosted MCP server and a direct API CLI. It does not install arbitrary third-party
MCP servers or expose a shell/file/network tool. Local MCP-server sandboxing and third-party tool
installation approval therefore belong to the consuming host, not an unimplemented Fidy feature.

## Findings addressed

**Low: MCP transport checks depended partly on later boundaries.** Public ingress accepted any
request URL authority and Host header before replacing them with `core.internal`. Cloudflare's
production hostname routing and disabled workers.dev already limit public exposure; no credential
or cross-User bypass was demonstrated. Local or changed routing nevertheless lacked an application
check. A request with Fidy's browser Origin also passed public ingress and reached Core admission;
the native MCP runtime's empty Origin allowlist rejected it only after authentication. Without a
bearer it returned 401 instead of the native transport's intended 403.

`cloudflare/public-worker.ts` now rejects unexpected MCP URL origins, mismatched explicit Host
headers, and every present Origin before Core forwarding. Production requires the fixed HTTPS API;
the two explicitly configured local modes permit only their exact loopback API origins. Non-browser
requests without Origin continue through normal authentication. This enforces the existing native
client policy earlier, without adding an authentication alternative.

`cloudflare/public-worker-mcp.test.ts` reproduced seven failing cases before the change. It covers
foreign/suffix hosts, insecure production transport, unexpected ports, production loopback rejection,
Host substitution, first-party/foreign/null/empty Origin, and the three allowed Origin-less topology
modes. Refusals assert no Core call and no-store responses. These tests use the real public Worker
with a replaced Core service binding; they do not claim to test Cloudflare DNS routing.

**CLI: no new security finding in the reviewed paths.** The review found the relevant protections
below already implemented. No speculative CLI rewrite was needed.

## Implementation evidence

Paths below are relative to the repository root. Existing tests are evidence for their named
boundaries, not proof of all possible attacks.

| Control                                | Installed behavior and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP authentication and least privilege | `apps/server/cloudflare/oauth-agents/internal/mcp-caller.ts` resolves live OAuth authority; `apps/server/cloudflare/canonical-operations/operations.ts` rechecks scope, User and Consent. `oauth-ingress.test.ts`, `oauth-canonical.test.ts`, and `oauth-discovery.test.ts` exercise revoked/expired authority, isolation and scope-private discovery.                                                                                                          |
| Credential lifecycle                   | OAuth code/refresh owners use digest-only credentials, S256 binding, fixed resource/client and absolute grant expiration. `oauth-ingress.test.ts`, `oauth-refresh.test.ts`, and `oauth-management.test.ts` cover substitution, replay, rotation and revocation.                                                                                                                                                                                                 |
| Tool integrity and validation          | `apps/server/src/shell/mcp/contract.ts` projects canonical schemas; `apps/server/cloudflare/mcp/runtime.ts` compares the live catalog fingerprint and credential binding before execution. Canonical decoding rejects excess properties. `oauth-discovery.test.ts` and `oauth-canonical.test.ts` cover catalog privacy and invalid calls. Fingerprinting is local residency consistency, not a signed package or client-side tool pin.                          |
| Sensitive effects                      | `apps/server/cloudflare/mcp/native-confirmation.ts` and `apps/server/cloudflare/oauth-confirmation/` bind native decisions to exact server-owned intents. `oauth-confirmation.test.ts` covers changed input, wrong authority, replay and atomic consumption. See the accepted client-assertion limitation below.                                                                                                                                                |
| Resource abuse                         | OAuth bootstrap/source admission, stable-User canonical pressure, bounded streamed bodies, deadlines and resident-owner limits exist in OAuth/MCP and Canonical Admission. `oauth-ingress.test.ts`, `oauth-allowance.test.ts`, `oauth-mcp-free.test.ts`, and `oauth-native-residency.test.ts` exercise these controls.                                                                                                                                          |
| Audit and secret minimization          | MCP calls use canonical metadata-only Audit and bounded Work observations. Credentials and financial bodies are excluded by the existing security contract. The OAuth tests assert attributable outcomes. Full tool-argument logging would conflict with Fidy's privacy policy and is deliberately not added.                                                                                                                                                   |
| CLI command execution                  | `apps/cli/src/login/browser.ts` launches a fixed platform opener with an argument vector, no shell, scoped cleanup and a five-second bound. The approval URL comes from fixed-origin pairing construction. Canonical operations use the HTTP client, not OS commands.                                                                                                                                                                                           |
| CLI credential storage                 | `apps/cli/src/credential/runtime.ts` uses native OS storage with no plaintext fallback; local metadata is bounded and checked against the bearer short id. UNIX paths require private permissions and reject symlinks at the checked path. `credential/runtime.test.ts` covers mismatch, partial persistence and locking; `test/native-store.ts` checks cross-process native persistence. This does not promise protection from compromise of the same OS User. |
| CLI transport and input                | `apps/cli/src/direct-client/runtime.ts` fixes the HTTPS origin, refuses redirects, omits ambient cookies, limits bytes/deadlines and disables content telemetry. `apps/cli/src/canonical/operations.ts` strictly decodes inputs and does not retry uncertain mutations. Direct-client resource/failure tests and canonical mutation tests exercise these decisions.                                                                                             |
| CLI output and distribution            | Command/canonical formatters escape terminal controls and expose closed local errors. Installers validate versions, checksum archives, constrain archive contents and quote PATH entries. Runtime revisions are pinned. `command/operations.test.ts` and canonical tests cover output; release workflow evidence remains separate from this local review.                                                                                                       |

## Accepted limits and responsibilities

- OAuth confirmation intentionally trusts an authorized client's native acceptance, including a
  modified client or hook. It cannot independently prove human presence. This is the accepted #988
  decision in `SECURITY_STANDARDS.md` and ADR 0033, not newly fixed by this review. Initial OAuth
  permission approval still requires the fresh first-party browser flow.
- Tool result text remains untrusted data. Canonical authorization and exact-action guards constrain
  subsequent calls; no claim is made that text filtering eliminates prompt injection in external
  agents. The consuming host owns context separation and its own tool approval UI.
- Client-side schema pinning, remote-server certificate pinning beyond ordinary TLS validation,
  host sandboxing, and independent human attestation are not established by this code review.
  Optional message signing is not treated as a required MCP protocol feature.
- Supply-chain scanning, platform-native macOS/Windows evidence, and production deployment controls
  retain their CI/release gates. This review does not replace them or enable hosted MCP for launch.

## Verification

The PR records the completed local checks and GitHub checks for its exact revision. The CLI behavior
suite passed all 80 tests during review, and cloud setup passed real Linux native-store cross-process
persistence. The new ingress tests were run before and after the fix; the complete OAuth adapter
suite and repository static gate are also required for this change.
