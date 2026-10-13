# OWASP reference verification — 2026-10-13

Checked official OWASP pages and their linked documents on 2026-10-13. This is a
reference reconciliation, not implementation verification or an ASVS assessment.
Fidy applicability below follows [SECURITY_STANDARDS.md](../../SECURITY_STANDARDS.md).

## Edition decisions

| Reference                   | Verified status and disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web Top 10                  | The official site presents **2025** as the release. Retain it for web, backend and infrastructure boundaries. [Source](https://top10.owasp.org/2025/)                                                                                                                                                                                                                                                                                                                                                                                                     |
| API Security Top 10         | The official edition index exposes **2023** and 2019. Retain 2023 for API authority and consumers. [Source](https://api-security.owasp.org/editions/2023/en/0x11-t10/)                                                                                                                                                                                                                                                                                                                                                                                    |
| LLM Applications Top 10     | **2026 exists:** the official resource page is dated August 3, 2026 and links a version-2026 PDF. Its cover and revision history still contain publication-date placeholders, while the general LLM landing page still labels its list 2025. Pin the linked 2026 artifact with this qualification; do not infer nonexistence from the stale landing page. [Resource](https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/), [PDF](https://genai.owasp.org/download/56857/?tmstv=1785822482), [landing page](https://genai.owasp.org/llm-top-10/) |
| Agentic Applications Top 10 | **2026**, published December 9, 2025; retain alongside the LLM list. [Resource](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/), [PDF](https://genai.owasp.org/download/52117/?tmstv=1765059207)                                                                                                                                                                                                                                                                                                                        |
| MCP Top 10                  | **2025 beta**: the roadmap explicitly identifies its current phase as beta, despite the page's separate “Production Project” classification. Retain the dated beta snapshot; the classification does not establish final document status. [Source](https://owasp.org/projects/mcp-top-10?tab=main)                                                                                                                                                                                                                                                        |
| ASVS                        | Retain the separately pinned **5.0.0** detailed-control reference; this note does not upgrade its version or establish any verification level. [Pinned source](https://github.com/OWASP/ASVS/tree/v5.0.0)                                                                                                                                                                                                                                                                                                                                                 |

CLI and a generic server do not need invented standalone lists: assess their actual
credential, input, authorization, runtime and distribution boundaries using the
references above. MCP and the hosted agent remain server-owned surfaces.

## Category inventory

Titles and identifiers below are OWASP category labels. MCP identifiers are normalized
to two digits, matching its main-page index; its Top10 tab mixes padded and unpadded IDs.

### Web 2025

[Official category index](https://top10.owasp.org/2025/0x00_2025-Introduction/):

| ID       | Category                              |
| -------- | ------------------------------------- |
| A01:2025 | Broken Access Control                 |
| A02:2025 | Security Misconfiguration             |
| A03:2025 | Software Supply Chain Failures        |
| A04:2025 | Cryptographic Failures                |
| A05:2025 | Injection                             |
| A06:2025 | Insecure Design                       |
| A07:2025 | Authentication Failures               |
| A08:2025 | Software or Data Integrity Failures   |
| A09:2025 | Security Logging & Alerting Failures  |
| A10:2025 | Mishandling of Exceptional Conditions |

### API 2023

[Official category index](https://api-security.owasp.org/editions/2023/en/0x11-t10/):

| ID         | Category                                        |
| ---------- | ----------------------------------------------- |
| API1:2023  | Broken Object Level Authorization               |
| API2:2023  | Broken Authentication                           |
| API3:2023  | Broken Object Property Level Authorization      |
| API4:2023  | Unrestricted Resource Consumption               |
| API5:2023  | Broken Function Level Authorization             |
| API6:2023  | Unrestricted Access to Sensitive Business Flows |
| API7:2023  | Server Side Request Forgery                     |
| API8:2023  | Security Misconfiguration                       |
| API9:2023  | Improper Inventory Management                   |
| API10:2023 | Unsafe Consumption of APIs                      |

### LLM 2026 and migration from 2025

[2026 PDF, table of contents and change summary, pp. 3–7](https://genai.owasp.org/download/56857/?tmstv=1785822482);
[2025 category index](https://genai.owasp.org/llm-top-10/):

| 2026 ID    | Category                         | Former 2025 ID                    |
| ---------- | -------------------------------- | --------------------------------- |
| LLM01:2026 | Prompt Injection                 | LLM01:2025                        |
| LLM02:2026 | Sensitive Information Disclosure | LLM02:2025                        |
| LLM03:2026 | Excessive Agency                 | LLM06:2025                        |
| LLM04:2026 | Supply Chain                     | LLM03:2025                        |
| LLM05:2026 | Data and Model Poisoning         | LLM04:2025                        |
| LLM06:2026 | Unbounded Consumption            | LLM10:2025                        |
| LLM07:2026 | Misinformation                   | LLM09:2025                        |
| LLM08:2026 | Hidden Context Exposure          | LLM07:2025, System Prompt Leakage |
| LLM09:2026 | Vector and Embedding Weaknesses  | LLM08:2025                        |
| LLM10:2026 | Improper Output Handling         | LLM05:2025                        |

The revision broadens injection to multimodal carriers, supply-chain risk to model-artifact
identity, poisoning to fine-tuning subversion, and output handling to generated insecure
code. Hidden-context controls cover more than the system prompt. It emphasizes independent
authorization, grounding before action, and hard resource budgets. [2026 PDF, pp. 7,
13–14, 24–25, 40–41, 44, 46–49, 56–57](https://genai.owasp.org/download/56857/?tmstv=1785822482).

Fidy dispositions for the implementation assessment:

- Re-key existing evidence using the crosswalk; never silently reuse a bare LLM ID.
- Extend prompt-leakage evidence to developer instructions, tool schemas, retrieved
  policy/context and intermediate model outputs. Treat their secrecy as providing no
  authorization. Prove Secrets stay outside model-visible inputs.
- Exercise hostile ingestion, tool results and persistent Memory/Transcript, including
  non-chat carriers that the current implementation accepts. Do not mark these absent
  merely because Fidy does not train models.
- Verify stable-User budgets, bounded model output and tool loops, cancellation and
  spend rejection before inference. Document any provider-level cap requiring deployment.
- Verify model claims cannot substitute for current state, authorization or successful
  operation receipts. Financial accuracy and truthful user-facing completion still need
  their own evidence; a security boundary alone cannot prove factual correctness.
- Recheck whether model training, model-artifact loading, generated-code execution and
  vector stores exist. Mark only absent sub-capabilities inapplicable, with a revisit
  trigger; retain ingestion and ordinary application dependency controls.

These are assessment requirements inferred for Fidy, not assertions that its code already
satisfies them. No other reviewed list needs an edition migration in this reconciliation.

### Agentic 2026

[Official PDF, contents pp. 3–5](https://genai.owasp.org/download/52117/?tmstv=1765059207):

| ID    | Category                             |
| ----- | ------------------------------------ |
| ASI01 | Agent Goal Hijack                    |
| ASI02 | Tool Misuse and Exploitation         |
| ASI03 | Identity and Privilege Abuse         |
| ASI04 | Agentic Supply Chain Vulnerabilities |
| ASI05 | Unexpected Code Execution (RCE)      |
| ASI06 | Memory & Context Poisoning           |
| ASI07 | Insecure Inter-Agent Communication   |
| ASI08 | Cascading Failures                   |
| ASI09 | Human-Agent Trust Exploitation       |
| ASI10 | Rogue Agents                         |

### MCP 2025 beta

[Official category index and beta roadmap](https://owasp.org/projects/mcp-top-10?tab=main):

| ID         | Category                                             |
| ---------- | ---------------------------------------------------- |
| MCP01:2025 | Token Mismanagement & Secret Exposure                |
| MCP02:2025 | Privilege Escalation via Scope Creep                 |
| MCP03:2025 | Tool Poisoning                                       |
| MCP04:2025 | Software Supply Chain Attacks & Dependency Tampering |
| MCP05:2025 | Command Injection & Execution                        |
| MCP06:2025 | Prompt Injection via Contextual Payloads             |
| MCP07:2025 | Insufficient Authentication & Authorization          |
| MCP08:2025 | Lack of Audit and Telemetry                          |
| MCP09:2025 | Shadow MCP Servers                                   |
| MCP10:2025 | Context Injection & Over-Sharing                     |

## Evidence boundary

For each applicable category, record implemented controls, exact negative tests and
observed results separately. Shared controls may serve multiple categories and surfaces,
but a policy citation or passing aggregate CI is not category-specific evidence. Keep
accepted client-asserted confirmation risk explicit; do not describe it as verified human
presence. Operational alert delivery and response, supplier assurance and external-server
governance require evidence from their actual owner, not a new prose claim of coverage.
