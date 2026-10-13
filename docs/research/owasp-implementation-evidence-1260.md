# OWASP implementation evidence — #1260

Assessment date: 2026-10-13. Implementation baseline:
`01a63f1c414b1877a9abd6c68d8b8de2fb840af6`, merged [#1259](https://github.com/B4rz99/fidy-ai/pull/1259).
This follow-up verifies the controls behind the policy mapping, reconciles LLM 2026, and records
remaining obligations. It is not certification, exhaustive penetration testing, an ASVS verification
level, or evidence of production launch readiness.

## Reading the evidence

Each category row in the linked assessments identifies the implemented boundary, exact negative
test and its observable claim. **Verified (scoped)** means that named control was inspected and its
stated evidence is available; it does not mean every recommendation in the category is satisfied.
**Partial** names a material limit. **Accepted risk** cites the existing decision, not a new waiver.
**Not applicable** identifies an absent capability and its reassessment trigger. **Unverified** is an
outstanding evidence requirement, never a passing result. A suite's skipped cases are not verified.

The [reference reconciliation](owasp-reference-verification-2026-10-13.md) lists all 50 categories
and the LLM 2025 → 2026 crosswalk. The official linked 2026 PDF still has publication-date
placeholders; this assessment pins that artifact explicitly. MCP remains a dated beta reference.
ASVS 5.0.0 is a detailed reference only; no requirement-by-requirement ASVS claim is made.

## Category and surface coverage

| Assessment                                               | Categories                                                                  | Fidy surfaces                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [Web/API evidence](owasp-web-api-evidence-1260.md)       | All ten Web 2025 and all ten API 2023 categories, plus CLI control evidence | Web, server/API, CLI, shared runtime and infrastructure                   |
| [Agent/ingestion evidence](owasp-agent-evidence-1260.md) | All ten LLM 2026 and all ten Agentic 2026 categories                        | Hosted agent, ingestion, Memory/Transcript and agent background execution |
| [MCP evidence](owasp-mcp-evidence-1260.md)               | All ten MCP 2025 beta categories                                            | Hosted MCP, OAuth, browser approval and external-agent boundary           |

Shared controls are referenced, not duplicated into contradictory per-application policies.
MCP and the hosted agent are server-owned. There is no invented generic server or CLI Top 10.
Background and infrastructure applicability follows the actual authorization, provider, queue,
retention, deployment and resource boundaries recorded in these assessments.

## Outstanding responsibilities

| Requirement                                    | Disposition and completion evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security-event detection and incident response | [#1262](https://github.com/B4rz99/fidy-ai/issues/1262) owns bounded abuse detection, live receipt/acknowledgement, a synthetic response exercise and deployed budget/edge evidence. The new [response procedure](../operations/security-response.md) supplies ownership, triage, containment and recovery; it is not an exercised incident programme. The bounded, lossy Core warning now includes authentication, exact provider callback validation and MCP canonical refusal bursts; distributed/edge and some protocol detection and live evidence remain incomplete. See the [background-work runbook](../operations/cloudflare-background-work.md). |
| Supply-chain risk                              | Existing SCA, release-age and immutable-input gates remain mandatory. The accepted braces advisory and its unchanged exclusive 2026-10-17 expiry remain tracked by #1262 and [the hardening record](../operations/security-hardening-1250.md). Scanner success with an explicit exclusion does not mean no vulnerable dependency.                                                                                                                                                                                                                                                                                                                         |
| Model behavior and misinformation              | [#1263](https://github.com/B4rz99/fidy-ai/issues/1263) owns measured adversarial/accuracy evaluation of the exact approved model under a bounded authorized budget. Hostile-model fixtures verify execution boundaries; they do not prove semantic injection resistance, factual accuracy or truthful free-text claims. See the agent assessment for the repeatable procedure.                                                                                                                                                                                                                                                                            |
| Independent human confirmation                 | OAuth sensitive-operation confirmation deliberately trusts the authorized client's native assertion under [ADR 0033](../adr/0033-hosted-mcp-and-oauth-agent-grants.md). A modified client/hook can accept; no human-presence guarantee is made. Existing exact-intent, expiry and single-use controls remain mandatory. Changing this product trust contract requires a separate decision, not a silent “security fix.”                                                                                                                                                                                                                                   |
| External MCP host governance                   | Fidy controls its server, grants, catalog and exposure. Consumer-host inventories, arbitrary third-party servers and their sandboxing are outside Fidy's execution authority. Adding third-party server installation or agent delegation reopens this applicability decision.                                                                                                                                                                                                                                                                                                                                                                             |
| Absent model capabilities                      | Fidy-owned model training/fine-tuning, vector/embedding stores and model-generated code execution are not current capabilities. Hostile ingestion and persisted context remain applicable and are assessed; absence of training never exempts those paths. Reassess when an absent capability is introduced.                                                                                                                                                                                                                                                                                                                                              |

Rechecked the [GitHub advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
through `gh api /advisories/GHSA-vfj7-8cjw-p6xm` on 2026-10-13: the affected range is
`braces <= 3.0.3`, `first_patched_version` is null, and the advisory update is 2026-10-02.
No admitted patched release was established and no exception was extended.

Closed [#725](https://github.com/B4rz99/fidy-ai/issues/725) and
[#920](https://github.com/B4rz99/fidy-ai/issues/920) explicitly carried uncompleted launch evidence;
closure is not proof of alert delivery or launch authorization. This assessment performs no
production fault injection, account configuration, real-user action or provider message/charge.

## Verification provenance

The baseline PR's [CI run](https://github.com/B4rz99/fidy-ai/actions/runs/38351966667) passed its
applicable gates before merge. That is prior evidence for the exact baseline, not a substitute for
category-specific assertions or a claim that every suite was rerun here. Each assessment records
its focused reruns, skips and limits. Subsequent source changes require rerunning their affected
negative tests and updating the row before carrying its scoped status forward.

The follow-up branch was rebased onto `297d71b5965d1ddcfba6d25d9d1d8187ebced48f`
(#1255) before final verification. Its native response ownership, scoped MCP lifetime and
hosted-provider construction changes were inspected; the initial focused reruns above remain
historical results for their stated baseline. The final PR checks validate the combined revision.

Final local verification on the combined branch:

- `bun run verify -- --group static`: passed, including type-aware lint, architecture rules,
  generated-contract freshness, dependency policy and the reviewed security manifest.
- `bun run --cwd apps/server test:cloudflare cloudflare/core-http/runtime.test.ts cloudflare/runtime/operational-health cloudflare/runtime/runtime.test.ts cloudflare/agent/hosted-turn.test.ts cloudflare/oauth-agents/oauth-confirmation.test.ts cloudflare/oauth-agents/oauth-native-residency.test.ts --maxWorkers=1 --no-file-parallelism`:
  **196 passed, 1 existing optional skip, 15 files**. This clean run includes the revised hostile
  context tests, new monitoring tests and trunk's MCP residency changes. It does not erase the
  earlier timing failures recorded in the MCP assessment.

The new monitoring evidence is scoped to concentrated Core refusals. It establishes neither
complete attack detection nor deployed notification receipt; #1262 remains open.

## Operational follow-up

The [#1262 operational record](owasp-operational-followup-1262.md) retains the later
protected release checks, operator-channel configuration inventory and dependency
reassessment. It distinguishes those observations from outstanding live receipt,
incident exercise and account-notification evidence.
