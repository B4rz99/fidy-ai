# Coordinated stable Effect integration (#978–#981)

**Status: migration merged and released on 2026-10-03.** This is a historical migration record,
not a pending handoff or an instruction to reapply its dependency snapshot.

## Final outcome

[PR #992](https://github.com/B4rz99/fidy-ai/pull/992) merged the complete #978–#981 migration as
`152e7d421f68574e46445e3e3cc00c4757e605a3`.

- [Final independent review and CI evidence](https://github.com/B4rz99/fidy-ai/pull/992#issuecomment-5971693618):
  Standards / Security / Spec reported **0 / 0 / 0 findings** across all four slices.
- [PR CI](https://github.com/B4rz99/fidy-ai/actions/runs/37140440789) succeeded, including native
  adapters, infrastructure, builds, unit/artifacts, Workspace Gate, Secrets, SAST, SCA, and Required
  Checks. [Exact Linux browser acceptance](https://github.com/B4rz99/fidy-ai/actions/runs/37140440789/job/111253637838)
  reported **37 passed**, resolving the local port limitation recorded below.
- [Automatic Production release](https://github.com/B4rz99/fidy-ai/actions/runs/37140919339) succeeded
  for the squash revision. The [final release record](https://github.com/B4rz99/fidy-ai/pull/992#issuecomment-5971763993)
  records promotion/probe evidence and closure of all four migration issues.
- This release did not authorize onboarding or real-user launch and installed no MCP/OAuth authority.
  The braces advisory remained accepted risk at release, not a remediation claim.

The [preparation](effect-4-stable-migration.md) and [portable](effect-4-stable-portable.md) reports
preserve intermediate evidence. The sections below preserve the **pre-merge implementation record**:
commands, lock hashes, temporary log paths, admission exceptions, vulnerability status, and pending
gates describe that checkpoint, not today's worktree or an outstanding migration. Current API
references are in [the selected source map](../../.patterns/effect-4-stable.md); current dependency
policy and exceptions are owned by the repository's policy files, not this historical report.

## Source and behavior (pre-merge record)

- Exact Effect 4.0.0 family: 11 direct declarations and eight locked coordinated packages.
  Alchemy beta.80 / Distilled rc.13 are the admitted required upgrades. Independent toolchain pins
  and all resource names, Workflow versions, binding ownership and deployment topology stay fixed.
- Native HTTP, API and SQL imports use the public stable paths. Hex/Base64Url replace the removed
  Encoding module at existing proof/digest/entropy boundaries. Entropy still comes from platform
  Crypto. Prefix and UTF-16 length checks use the renamed equivalent Schema APIs.
- Web transport/Atom consumers use `effect/http`, `effect/http-api` and `effect/reactivity`.
  Registry isolation, expiry/revocation, bounded requests, credential lifetime, billing and financial
  behavior remain owned by their existing interfaces. No hook/state lifecycle was redesigned.
- The root dependency-policy checker and document-parsing harness import stable HTTP. Native,
  browser and artifact deny rules recognize stable SQL/HTTP/AI paths. The new hashed-asset SQL
  rejection test was red before the artifact marker fix and green after it.
- Beta.80 moved the CLI. Its wrapper forces a global TS config under Bun, breaking `~` imports.
  Tooling invokes its actual `bin/alchemy.js` entrypoint, which calls public main/runMain APIs;
  real Alchemy local-emulation tests prove ingress-to-Core service binding and browser serving.
  This is not a compatibility loader, additional runtime or local substitute for Cloudflare authority.
- The reviewed edge digest changes only because two covered files replaced Encoding with equivalent
  Hex imports/calls. Their semantic diff was inspected: no origin, credential, resource, header,
  route or rollout policy changes. The exact-digest tripwire and every release control remain.
- The used beta.80 provider patch remains; unused beta.79 and the temporary candidate replay artifact
  are removed. The original replay is archived at preparation commit `e5635f5f6a`. Current source
  citations are in `.patterns/effect-4-stable.md`; old vendored RC examples are explicitly historical.
- Money, 55 canonical operation policies and typed wire/access meaning retain the #979 evidence.
  PAT-pairing OpenAPI and operation-policy JSON are unchanged; canonical OpenAPI's four documented
  projection differences are reviewed against decoding, not accepted as unexplained regeneration.

No new external workflow was added. Existing bounded Worker/provider Work observations and metadata
projections remain at their existing boundaries; namespace and representation changes introduce no
new telemetry purpose. Live provider rollout and Production execution are not claimed by local tests.

## Verification (local pre-merge record)

Logs: `/tmp/fidy-980-evidence/`; earlier seam evidence: `/tmp/fidy-979-evidence/`.
During implementation, the first type-aware lint exposed remaining namespaces; those failures were
fixed before expanding behavior. Full-root typecheck and type-aware lint are now green, without
changing diagnostics, strictness, lint rules, dependency policy or coverage thresholds.

| Command/group                                          | Evidence                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify -- --group static`                             | passed, including full ownership/negative probes, source-analysis tools, generated freshness, browser publication, policy, family and security-manifest gates |
| `verify -- --group builds`                             | passed: actual Production and portable Vite artifacts plus hostile-document workerd parsing proof                                                             |
| `verify -- --group unit`                               | passed: 381 core, 22 WhatsApp, 40 canonical, 26 email interpretation, five Memory, 250 web/coverage, 42 tooling, four artifact tests                          |
| `verify -- --group cloudflare-adapters`                | 66 files; 716 passed, four reported skipped; D1/DO/R2, two-User, atomicity, replay, interruption and durability evidence retained                             |
| `verify -- --group cloudflare-infra`                   | 25 files; 181 passed, including real Alchemy emulation and release-tool receipt/drift/rollback/preflight tests                                                |
| focused native admission/session/staging               | three files; 18 passed                                                                                                                                        |
| focused stable web transport/session/enrollment/editor | five files; 38 passed                                                                                                                                         |
| focused artifact/release-workflow tests                | passed; SQL artifact marker regression exercised red/green                                                                                                    |

The default local browser group could not start its HTTPS servers: ports 4173/4174 are occupied
by stale processes in the unrelated `720` worktree. Those processes were neither stopped nor reused
as migration evidence. A disposable worktree was inspected for port isolation and removed without
running an altered acceptance-origin graph. The exact configured browser group and Linux
verification still require fresh CI runners. No local browser or Linux pass is claimed merely
from a Vite build or mocked HTTP test.

## Supply-chain and release boundaries (pre-merge record)

The frozen lock SHA-256 remains `21e35b52db3930feea44ee9e4f921a81e88a28153a23042faecdab711ce199e1`.
The recorded one-time age exception admits only this snapshot; `minimumReleaseAge = 604800` and
its no-exclusions policy are unchanged. A final `bun install --frozen-lockfile --ignore-scripts`
and explicit `bun run postinstall` both passed with the ordinary cooldown configuration, without
an age override or lock change. CI must still satisfy the ordinary repository gates; changed
candidates require renewed admission rather than reusing the exception.

`bun audit` still reports the **pre-existing** high braces advisory, not a newly resolved clean audit.
The official [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) record has no
patched version and the npm registry still publishes 3.0.3 as latest. This is carried under the
**already-existing** paired `dependency-policy.json` / `.fluidattacks/sca.yaml` risk acceptance
(CVE-2026-93687, expiry 2026-10-10), which predates #978. Neither record was modified or extended.
The static dependency-policy gate validates that pair; CI must pass SCA with its established policy.
This is bounded accepted risk, not remediation or an SCA waiver from the cooldown exception.
Upstream must still be rechecked and the acceptance removed when an eligible remedy exists.

## Review and authorization requirements recorded before merge

The following requirements were pending at this checkpoint and were satisfied by the final review,
CI, and release evidence above; they are retained to document the original authorization boundary.

Independent Standards/Security/Spec review must cover the entire migration, not just #980/#981.
After synchronizing trunk, `git diff fe37ea1b8a...HEAD` includes every migration slice while excluding
#977's already-landed design. The User confirmed this fixed point. Combined review and exact Linux
browser and SAST/SCA CI checks remain merge requirements; a pending check, missing review or finding
prevents declaring #981 complete. Final review and CI evidence will be linked from the squash PR.

**Automatic Production release is explicitly authorized:** after being told the existing trunk-push
workflow deploys automatically and has no environment reviewer gate, the User confirmed that the
requested merge authorizes that release. No trigger or release policy was disabled. Authorization
is conditional on clean combined review and CI, and does not enable onboarding or real-user launch.
