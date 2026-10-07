# Hosted MCP release evidence — #990

**2026-10-07: local integration verified; release readiness incomplete; real-user enablement paused.**
This report covers [#990](https://github.com/B4rz99/fidy-ai/issues/990) under the live
[parent #33](https://github.com/B4rz99/fidy-ai/issues/33). The parent's current two-host decision
supersedes #990's older Pi wording. Pi/OpenCode/desktop clients/MCP Apps are not support claims.
No deployment, real-user authorization, synthetic Production grant, provider effect or baseline
replacement occurred. The [Spanish setup guide](../guides/hosted-mcp.md) is explicitly pre-release;
the [controlled-proof procedure](../operations/hosted-mcp-release.md) records remaining gates.

## Configuration and provenance

Starting/runtime revision: `1e743e2785b84d7cf944d04e533288b737dbef04`. The changes in this ticket
extend the existing release edge verifier and correct dropped GET headers; they add no domain
runtime, deployment path, D1 binding, credential authority or launch switch.

Effect **4.0.0**; Bun **1.4.3-canary.1+13a98b0db**; Vitest **5.0.2**;
Playwright **1.63.0**, macOS arm64. The production build reports canonical contract digest
`8ae4a5f864ac4263bc4f934e7952550a4eef2e20e9e73ce5dae80fc87cae1678`.
Frozen workspace and separately locked dependency-review tooling were installed without changing
locks. Local workerd uses the repository's native isolated D1 fixture and deployed entrypoints;
it does not pin Cloudflare's managed platform runtime.

## Exact-host evidence

The existing opt-in `oauth-confirmation.test.ts` bridge and
`scripts/mcp/native-confirmation-hosts.py` ran against real ingress/Core/canonical admission/D1.
Actual released CLIs rendered native dialogs in PTYs; scripted operator keystrokes accepted or
cancelled, without hooks. Each host used a fresh disposable profile and canned loopback model.
The bridge injected a synthetic approved credential; it did not perform browser OAuth login.

| Host                         | Protocol actually used                   | Native accept                              | Native cancel                        | Headless                             |
| ---------------------------- | ---------------------------------------- | ------------------------------------------ | ------------------------------------ | ------------------------------------ |
| Claude Code 2.1.289          | 2026-07-28, stateless keyed continuation | One Budget deletion and one accepted Audit | Budget retained, zero accepted Audit | Budget retained, zero accepted Audit |
| Codex CLI and daemon 0.160.0 | Offered 2025-06-18; selected 2025-11-25  | One Budget deletion and one accepted Audit | Budget retained, zero accepted Audit | Budget retained, zero accepted Audit |

All six cases passed; each called the actual sensitive canonical tool. Codex's optional GET/DELETE
session probes returned 405 while POST/native confirmation succeeded. Local tool-execution
permission is distinct from the exact native confirmation. Acceptance is the OAuth-authorized
client's assertion, not independently verified human presence. Normalized, content-free outcomes
and recording time are in [native evidence](hosted-mcp-native-990.evidence.json).

The historical [#977 report](hosted-mcp-interoperability-977.md) used Claude Code 2.1.288 and Codex
0.160.0 with Effect 4.0.0, a simulated OAuth server and CIMD. It proved synthetic exchange and two
refresh/reconnects, not installed Fidy authorization. Current issuer metadata advertises DCR and
`client_id_metadata_document_supported: false`; arbitrary metadata URLs are refused. Actual-host
DCR selection/fallback and callback handling against this installed authority remain unproved.
Do not combine historical simulator login and current injected-grant confirmation into one
end-to-end support claim.

## Executed integration evidence

Commands used the pinned Bun on the same source tree; focused native tests needed local socket
permission. No suite or threshold was relaxed. The isolated browser command must set
`CLI_ACCEPTANCE_MODE=oauth` in the test process as well as its servers; without it tests address
the default topology and fail with connection refusal. Rerunning with that mode passed.

| Seam / command                                                                                                                                                                                 | Result                                        | What it proves                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run --cwd apps/server test:cloudflare cloudflare/oauth-agents cloudflare/transactions/oauth-review.test.ts`                                                                               | 222 passed; one opt-in host bridge skipped    | Declaration-derived catalog, canonical owners, scope/User isolation, atomic batches, Consent, PKCE/substitution/replay, absolute expiry, rotation/revocation, confirmation, #35 allowance and retry identity at native ingress/Core/D1 seams.                                                                   |
| Opt-in host bridge with the pinned host runner                                                                                                                                                 | One bridge test passed; six host cases passed | Actual native host presentation/continuation and once-only D1 mutation/Audit; excludes OAuth login and model inference.                                                                                                                                                                                         |
| `bun run test:contracts`                                                                                                                                                                       | Four passed                                   | Generated contract/policy artifact freshness.                                                                                                                                                                                                                                                                   |
| `bun run --cwd apps/web test -- src/features/oauth-connections scripts/production-workflow.test.ts scripts/build-production.test.ts scripts/cloudflare-adapter.test.ts`                        | 42 passed                                     | Spanish permission/duration/management presentation and static artifact/release policies.                                                                                                                                                                                                                       |
| `CLI_ACCEPTANCE_MODE=oauth bun --bun playwright test --config playwright.oauth.config.ts` in apps/web                                                                                          | Five passed                                   | Built browser, established synthetic sign-in, narrowed scope/lifetime approval, callback exchange, expiry/revocation and separate PAT/logout controls, forged/hostile inputs and bounded bootstrap pressure at real ingress/Core. Browser approval delivery is a loopback operator fixture, not a real channel. |
| `bun run --cwd infra/cloudflare test -- verify-edge-smoke.test.ts workers.test.ts production-preflight.test.ts production-release.test.ts release-controller.test.ts release-rollback.test.ts` | 96 passed                                     | Release preflight/controller/rollback, ingress ownership/policy and expanded edge gate.                                                                                                                                                                                                                         |
| `RELEASE_GIT_SHA=1e743e2785b84d7cf944d04e533288b737dbef04 bun run --cwd apps/web build:production`                                                                                             | Passed                                        | Actual validated production-mode static artifact, not only build-policy fixtures.                                                                                                                                                                                                                               |

Streaming/resource evidence is in `oauth-native-residency.test.ts` (actual streamed request/response
bounds, resident-owner/concurrency limits and disconnect cleanup), `oauth-ingress.test.ts`
(authentication/registration/source/User pressure, interruption before queued work),
`oauth-refresh.test.ts` (rotation replay/concurrency and lost delivery), and
`oauth-allowance.test.ts` (shared allowance, non-admission pacing, retained outcomes and ambiguous
mutation delivery without blind retries). Earlier security suites were rerun, not deferred to this
ticket. These are simulated protocol clients at a native platform seam, distinct from real hosts.

`SECURITY_STANDARDS.md` and telemetry's closed metadata projection prohibit bodies, bearer/code URLs,
financial content and raw errors. Runtime telemetry remains owned by existing ingress/Core and
canonical Audit. No new external workflow or telemetry exporter was added. The existing focused
`bun run --cwd apps/server test:cloudflare cloudflare/runtime/telemetry.test.ts` passed nine tests;
`bun run --cwd apps/server test -- src/shell/observability/telemetry.test.ts --coverage.enabled=false`
passed seven. These cover sanitized success/failure/interruption outcomes and preservation of the
application result, not effective live export configuration. The first shell invocation passed its
seven tests but failed the whole-source coverage threshold because only one file ran. The focused
rerun disabled coverage collection; repository thresholds and the full CI gate remain unchanged.

## Production observations

Credential-free bounded GETs at **2026-10-07 10:47:49 UTC** observed:

- `https://api.fidyapp.com/.well-known/oauth-protected-resource/mcp`: 200; exact MCP resource and
  issuer, minimal `read` discovery scope and header bearer transport, as required by ADR 0033.
- `https://api.fidyapp.com/.well-known/oauth-authorization-server`: 200; exact issuer, authorize,
  token and registration URLs, S256, code/refresh grants, public-client authentication, explicit
  issuer response support and CIMD unavailable. `read`/`write`/`dashboard` are advertised by the AS;
  no write permission follows from the minimal resource challenge.
- `https://api.fidyapp.com/mcp`: 401 with exact protected-resource challenge. All three had
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and no permissive CORS header.

The expanded `bun infra/cloudflare/verify-edge-smoke.ts` subsequently passed all 14 credential-free
probes against normal Production traffic, including invalid authority and hostile Origin. It
never sent a valid grant, provider event or User mutation. Responses were scoped, deadlines bounded,
and unconsumed bodies aborted. The two new regression tests first failed (missing discovery
coverage and dropped GET headers), then passed with the implementation.

The latest [Production run 37556877976](https://github.com/B4rz99/fidy-ai/actions/runs/37556877976)
completed successfully at the starting revision. Its complete topology plan, exact-pair promotion,
normal traffic, public topology and **previous** edge gate passed. It predates this verifier change;
it is not evidence that the expanded candidate gate has run in Production. The sole Alchemy stack
retains public ingress without D1, private Core via service binding, assets-only web and protected
release authority. Live account secret correctness/least privilege and all platform limits require
operator evidence; static checks cannot certify them.

## Remaining gates and acceptance status

| #990 requirement                                                                                                                                                         | Status / missing evidence                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact supported hosts complete add URL → existing sign-in → narrowed review/duration → approve → query/mutation/batch → confirmation → refresh/reconnect → expiry/revoke | Partial. Current native confirmation/discovery passes, and assembled browser/protocol suites pass separately. Each exact host's complete journey against installed authority, especially DCR fallback, remains pending. |
| Spanish setup/troubleshooting                                                                                                                                            | Prepared in the guide, with verified URL and explicit pre-release/host limitations. Publication to users waits for host/enablement gates.                                                                               |
| Alchemy, ingress/Core, OAuth exposure, Origin/CORS/cache/referrer, secrets/static safety                                                                                 | Local release/artifact gates and live credential-free exposure pass. Expanded zero-traffic candidate probes and restricted live configuration review remain pending.                                                    |
| Authentication/metadata bounds, streaming, rate/concurrency, interruption/ambiguous delivery, safe telemetry                                                             | Native behavior suites pass. CIMD fetch is unavailable, not unbounded. Effective Cloudflare limits and live telemetry success/failure/interruption proof remain pending.                                                |
| Assembled behavior/security and release checks                                                                                                                           | Focused suites and actual production artifact pass. Full CI and expanded candidate-pair release are separate gates.                                                                                                     |
| Safe synthetic Production proof                                                                                                                                          | Procedure prepared; no operator-authorized proving window or synthetic identity is recorded in this task. No remote grants/mutations were attempted.                                                                    |
| #35 and explicit real-user enablement approval                                                                                                                           | #35 and #989 are closed; shared OAuth tests pass. Operator approval is absent. Enablement remains paused, and readiness is incomplete while the proofs above remain pending.                                            |

The [Production launch runbook](../operations/production-launch.md) explicitly requires establishing
real-data presence, enforceable admission boundaries and operator approval before synthetic work.
Closure of #725/#920 and a green release do not supply these facts. No proof of a closed live ingress
or empty baseline is inferred. No new admission switch is silently introduced by this ticket.
Keep #990 open until the missing host and applicable Production evidence is recorded; do not
request or imply launch approval from passing local checks.
