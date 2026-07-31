# Security review

The security policy for reviewing changes to Fidy. It describes the attack surface of the planned
product in issue #1, not only the code that exists today. It is deliberately narrower than a
security programme: every rule here must be decidable from a code or configuration diff and its
tests.

A review applies a rule only when the diff introduces, changes, exposes, or worsens that rule's
attack surface. An unbuilt future capability is not a finding. A pre-existing weakness is a finding
only when the diff newly exposes it, worsens it, or relies on it.

The review asks **what must remain secure**, not how to implement it. Issue #1 and
`ARCHITECTURE.md` own already-adopted mechanics; this document turns their security consequences
into reviewable invariants.

---

## Scope

### Out of scope

- Operational or launch readiness: legal review, KYB, RNBD thresholds, incident procedures, and
  production credential rotation.
- The correctness of legal text or the Asesoría boundary; those belong to Spec review.
- Dependency, container-image, and CI-action supply-chain findings; SCA and the seven-day freeze
  policy own them.
- Findings already produced deterministically by an applicable automated gate. A concrete bypass
  of the intended gate remains reviewable.
- Surviving a total compromise of Kapso, Resend, Wompi, OpenAI, Railway, or another provider.

---

## Threat model

### Protected assets

1. **Secrets** — raw AgentTokens, provider credentials, signing secrets, magic and token-delivery
   links, device codes, recovery proofs, and protected-PDF passwords.
2. **Personal and financial data** — identity and recovery details, Transactions and
   SourceAttestations, Budgets, Categories, DashboardDocuments, Subscriptions and BillingAttempts,
   transcripts, RollingSummaries, UserNotes, NeedsReviewItems, and raw IngestSamples.
3. **Security evidence** — ConsentRecords, AuditLogEntries, token grants and revocations, provider
   message evidence, and immutable interpretation or policy revisions.
4. **State integrity** — User ownership, token scope, consent state, financial records, billing
   state, InsightEvent lifecycle, and retention/anonymisation state.
5. **Availability and spend** — request, parser, queue, model, messaging, and billing-provider
   capacity whose abuse can deny service or create unbounded cost.

### Threat actors and failure sources

- An unauthenticated internet attacker.
- A User, or one of their agents, attempting to reach another User's data or operations.
- A holder of a stolen, revoked, expired, replayed, or under-scoped bearer credential.
- A sender forging or replaying Kapso, Resend, Wompi, or queued work.
- Malicious instructions embedded in messages, emails, statements, images, receipts, UserNotes, or
  provider/model output.
- Accidental disclosure through logs, errors, URLs, browser state, transcripts, caches, or outbound
  provider payloads.
- Malformed or adversarial data returned by a provider, parser, model, database row, or queue.

### Trust boundaries

Every crossing is untrusted regardless of its TypeScript type or vendor:

- public HTTP, the SPA, magic-link and device flows;
- Kapso, Resend, Wompi, OpenAI, and other outbound or callback seams;
- AgentToken, hosted-agent, CLI, MCP, and typed-client calls;
- LLM prompts, tool requests, structured output, and generated presentation content;
- emails, PDFs, CSV/XLSX files, images, voice transcripts, and screenshots;
- PostgreSQL rows and JSONB, queue payloads, schedules, migrations, and environment configuration.

### Data handling classes

| class                     | review invariant                                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Secret**                | Exists only for its required lifetime and purpose. It does not enter logs, errors, analytics, transcripts, LLM context, broad application objects, or recoverable storage unless recovery is the security requirement. |
| **Personal or financial** | Access is bound to one explicit User and purpose. Persistence, model context, logs, and provider egress contain only what that purpose needs.                                                                          |
| **Security metadata**     | Only the approved identity, token id, operation, outcome, timestamp, and provider evidence needed for accountability are recorded. Metadata must not become a disguised request body.                                  |
| **Public**                | May be exposed intentionally, but still receives integrity, output-encoding, and cache review where it can influence trusted behaviour.                                                                                |

---

## Review invariants

Each section states when it applies, what must hold, and the evidence a reviewer should seek. The
examples are representative, not an exhaustive checklist.

### 1. Authentication, authorization, and User isolation

**Applies when:** a diff adds or changes an operation, caller resolver, repo query, object lookup,
cache, background path, scope, suggested operation, or User-owned model.

**Invariant:** access is deny-by-default. Every canonical operation and data path resolves an
explicit stable `UserId` and an applicable access policy, except a deliberately named public entry
point that verifies its own proof. Phone numbers, provider ids, message ids, object ids, and model
claims are evidence or input, never authority.

Every access to User-owned data is constrained by that `UserId`; possession of an opaque UUID does
not confer access. AgentToken scope is declared once on the canonical operation and governs HTTP
authorization, MCP/tool visibility, CLI availability, hosted-agent calls, and suggested operations.
The hosted agent uses the same authorization path as the User's own agents.

A non-request path that reads User data activates the architecture's RLS tripwire. Its diff must
resolve that decision and prove isolation beyond the request-derived API test. Queue work, caches,
schedules, retries, and model context must not mix Users.

**Evidence:** trace the subject and policy from entry point through handler and repository; inspect
all object-id reads and writes; verify an under-scoped caller cannot invoke or discover the
operation; verify User B cannot observe or alter User A.

**Violation examples:** a repo accepts `TransactionId` without `UserId`; a worker loads every due
InsightEvent and loses the subject before delivery; a tool is hidden from MCP but remains callable
over HTTP; an affordance advertises an operation the token cannot invoke.

### 2. Credential and recovery lifecycle

**Applies when:** a diff handles AgentTokens, web sessions, magic or one-time links, CLI device
flows, recovery, revocation, or WhatsAppIdentity changes.

**Invariant:** bearer material is unpredictable, narrowly purposed, bounded in usable lifetime,
and disclosed only through its intended one-time channel. Verification does not require retaining
recoverable bearer material when a digest suffices. Use, expiry, revocation, and replay are decided
at the authoritative boundary and take effect across every client surface.

Browser authentication state must resist theft, fixation, cross-origin use, and leakage through
URLs, referrers, scripts, caches, or diagnostics. Recovery and phone-number changes preserve the
stable User while requiring proof appropriate to their impact. Authentication failures do not
become a subject-enumeration oracle.

**Evidence:** follow the raw credential from creation through delivery, storage, verification,
rotation/revocation, and destruction; test reuse, expiry, revocation, wrong purpose, and wrong
scope.

**Violation examples:** a raw AgentToken is stored or pasted into chat; revocation affects HTTP but
not MCP; a magic link remains reusable; changing a phone number creates a new owner for old data.

### 3. Consent, privacy, retention, and egress

**Applies when:** a diff touches onboarding, consent, ingestion, transcripts, memory, retention,
anonymisation, provider payloads, reporting context, or personal-data deletion.

**Invariant:** before onboarding consent, Fidy performs no financial processing, answers no finance
question, and persists no User or financial content beyond what is strictly required to present and
record the consent decision. Consent and revocation evidence is tied to the stable User and retains
the exact historical context needed to remain interpretable.

Personal and financial data is collected, retained, loaded into model context, and sent to a
provider only for an explicit current purpose. Outbound payloads are projections of what the
recipient needs, not broad domain objects. Current User preferences never reinterpret historical
consent, ingestion, billing, schedule, delivery, or persisted-report artifacts.

Raw ingestion material has enforced bounded retention. Indefinite structural samples qualify only
after anonymisation removes identifying and transaction-specific values. Protected-PDF passwords
are transient Secrets. Fidy never solicits bank credentials or card/account numbers in chat, and
accidentally supplied sensitive values must not spread into logs, prompts, or unrelated storage.

**Evidence:** compare each collected or outbound field to its purpose; inspect pre-consent effects;
trace retention and anonymisation states; verify deletion/expiry is executable and tested rather
than documentary.

**Violation examples:** forwarding an entire transcript when one message is needed; keeping raw
emails indefinitely because anonymised fixtures also exist; saving a PDF password in the
transcript.

### 4. Validation, injection, and safe output

**Applies when:** a diff consumes data across any trust boundary or emits content into SQL, HTML,
Markdown, URLs, headers, file paths, commands, email, or another interpreter.

**Invariant:** every trust-boundary value is runtime-decoded before trusted use and remains
untrusted after transport authentication. Validation establishes structure and domain constraints;
contextual encoding or parameterisation prevents data from becoming code.

LLM output never receives privileged treatment. It is not directly executed, queried, rendered as
active content, used as a path or destination, or passed to a downstream interpreter.

**Evidence:** identify the first trusted use and the decoder before it; follow every untrusted value
to its output context; inspect redirects and caller-supplied destinations; test malformed values at
the public boundary and assert no partial effect.

**Violation examples:** trusting a typed provider SDK response without decoding it; interpolating a
model-produced merchant into SQL; rendering model Markdown with active HTML; decoding a queue job
after it has selected another User's rows.

### 5. Provider authenticity, replay, and state transitions

**Applies when:** a diff handles webhooks, inbound email, provider outcomes, message delivery,
queued jobs, retries, or externally initiated state changes.

**Invariant:** an external event proves its provider and integrity before causing effects. Replay or
redelivery cannot duplicate a security-sensitive effect. Authentication, idempotency/replay
checks, authorization context, and state transition compose atomically wherever a race could bypass
them.

Provider identifiers remain evidence rather than User identity. A BillingAttempt remains pending
until a verified Wompi outcome advances it, and delayed, duplicated, or out-of-order outcomes cannot
regress or contradict terminal state. Third-party responses receive the same validation, resource
bounds, and destination controls as hostile input.

**Evidence:** test invalid proof, altered content, duplicate delivery, reordering, concurrent
handling, and retry after partial failure; verify every rejected case leaves domain state
unchanged.

**Violation examples:** parsing a callback and writing state before verification; using a Kapso
contact id as the User; charging or delivering twice after redelivery; following a provider
redirect that forwards personal data to a new host.

### 6. Agent, prompt, and tool boundary

**Applies when:** a diff changes prompts, context assembly, memory, model calls, structured output,
tool generation/execution, agent loops, or model-rendered content.

**Invariant:** messages and all retrieved or ingested material are data, even when they contain
instructions. Direct, indirect, multilingual, encoded, and multimodal prompt injection may
influence model planning, but cannot grant identity, scope, cross-User access, or destructive and
irreversible side effects. A HostedAgentToken delegates canonical reads and reversible additions
for one hosted turn; exact User confirmation is required when canonical operation metadata marks an
effect as destructive or irreversible. Canonical operations independently enforce identity,
consent, scope, paywall, validation, and domain rules on every call.

The model receives only the operations and data needed for the current User and turn. It has no
private, open-ended, shell, SQL, arbitrary-file, or arbitrary-network capability. System-prompt
secrecy is not a security boundary and no Secret belongs in it.

Context assembly, summaries, caches, tool results, and transcripts stay User-isolated.

**Evidence:** trace identity, scope, and destructive authority independently of prompt
instructions; compare exposed tools with canonical operation metadata; inspect context selection;
use adversarial direct, indirect, and multimodal fixtures to prove cross-User access and
unconfirmed destructive effects fail.

**Violation examples:** trusting the model to decline a write for a read-only token; an emailed
instruction causing the agent to call another User's operation; a RollingSummary from one User
entering another User's turn.

### 7. Hostile ingestion material

**Applies when:** a diff accepts, decrypts, parses, stores, forwards, or renders an email, PDF,
CSV/XLSX file, image, screenshot, receipt, or voice transcript.

**Invariant:** uploaded material is hostile data throughout its lifetime. Claimed filename,
extension, MIME type, dimensions, row/page count, and embedded content do not establish safety.
Active content, formulas, macros, external references, archive expansion, user-controlled storage
paths, and parser output cannot become executable authority.

Original material is never served back as active content. Passwords and temporary plaintext have a
bounded in-memory lifetime.

**Evidence:** test mismatched type claims, malformed files, active references, hostile names, and
password cleanup; inspect every output sink.

**Violation examples:** trusting `.pdf` rather than file content; allowing a spreadsheet formula to
execute during processing; using an uploaded filename as a path.

### 8. Secrets, logs, errors, audit, and append-only evidence

**Applies when:** a diff adds logging, telemetry, error handling, audit, consent evidence, secret
loading, debug output, or request/provider/model capture.

**Invariant:** logs are allowlisted metadata, never broad objects later redacted. Request and
response bodies, authorization material, raw provider payloads, financial content, transcripts,
model prompts/responses, one-time links, and Secrets do not enter logs. Errors expose only the
canonical failure contract, never those values, stacks, SQL, parser dumps, provider bodies, or
internal topology.

Every canonical call remains attributable through a metadata-only AuditLogEntry containing the
stable subject, token identity where applicable, operation, outcome, and time—never the body.
Successful access or mutation cannot silently escape required auditing. ConsentRecords and
AuditLogEntries are not updated in place: correction and revocation append evidence; any approved
retention deletion is a separate, policy-bound path.

Secrets come from an intended secret boundary, remain out of source and non-secret configuration,
and are not copied into longer-lived values. Cryptographic decisions use established primitives
with properties appropriate to the Secret; custom cryptography is not a control.

**Evidence:** enumerate fields at every log/audit/error call; inspect failure paths and debug modes;
trace a Secret's lifetime; test that evidence cannot be rewritten through ordinary application
paths.

**Violation examples:** logging a decoded Transaction for convenience; returning a raw Effect or
SQL error; placing a provider credential in generated OpenAPI; upserting a revocation over the
original grant.

### 9. Browser, API, and runtime exposure

**Applies when:** a diff changes origins, browser authentication, response headers, redirects,
static content, debug behaviour, network listeners, secret configuration, container/runtime
privilege, or endpoint exposure.

**Invariant:** production exposure is explicit and least-privileged. Browser origin, framing,
script/content execution, MIME interpretation, and referrer boundaries prevent an untrusted site or
payload from exercising a User's authority or reading personal data. Credentialed cross-origin
access is never granted by a wildcard. Authentication and one-time material does not survive in a
leaking URL, cache, source map, or diagnostic surface.

Only intended operations and health/static surfaces are reachable. Production behaviour does not
expose debug endpoints, internal schemas beyond the canonical public contract, or privileged
filesystem/network capability. Security-relevant configuration fails closed when absent or
invalid.

**Evidence:** review effective production configuration rather than development defaults; trace
redirect targets and browser credential flow; inspect generated artifacts and publicly reachable
routes.

**Violation examples:** credentialed `Access-Control-Allow-Origin: *`; a magic-link token forwarded
through an open redirect; production source maps exposing embedded configuration; a missing signing
secret silently disabling callback verification.

### 10. Resource and cost abuse

**Applies when:** a diff adds public or token-authenticated work, model/provider calls, file
processing, queues, retries, login/recovery attempts, token minting, or concurrency.

**Invariant:** attacker-controlled input cannot trigger unbounded CPU, memory, storage, queue depth,
model iterations, tool calls, outbound messages, retries, or provider spend. Limits follow the
stable User and operation cost class where multiple tokens or channels could otherwise bypass
them. Expensive work is authorized and bounded before it is scheduled or purchased.

The control covers hostile resource consumption and economic denial of service, not ordinary
performance tuning. Rejection itself must be cheap enough that invalid authentication, malformed
files, or failing provider calls cannot become the more expensive path.

**Evidence:** identify every attacker-controlled multiplier and its owner, bound, cancellation, and
retry behaviour; test bursts, parallel calls, multiple tokens for one User, oversized inputs,
repeated failures, and model/tool-loop exhaustion.

**Violation examples:** minting tokens resets a User's quota; one statement creates unbounded model
calls per row; invalid bearer tokens trigger paid work before rejection; retry and webhook delivery
multiply the same outbound message.

---

## Required security evidence

A diff that adds or changes a security boundary includes a negative test at that boundary's stable
public seam, proving both rejection and absence of partial side effects against the applicable
section's evidence.

A missing required negative test is itself a Security finding. Its severity follows the impact of
the unproved boundary, not a fixed “test missing” severity. Existing derived guards remain derived:
new operations must enter their enumeration without a reviewer-maintained list.

---

## Finding standard

A concern qualifies as a finding only when the reviewer can show all of:

1. the affected file and hunk;
2. the violated section of this policy;
3. a concrete attack, unauthorized-action, integrity-loss, or leakage path;
4. the resulting impact; and
5. the smallest credible remediation.

Order findings by severity, then file. There are no informational findings and no generic hardening
list.

| severity     | meaning                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Critical** | Broad authentication bypass, mass cross-User exposure, raw credential compromise, or remotely controllable privileged execution.          |
| **High**     | Cross-User access, scope bypass, forged identity or billing state, or prompt injection that can cause unauthorized disclosure or effects. |
| **Medium**   | Conditional personal-data exposure, replayable side effects, unsafe retention, or a missing control with meaningful prerequisites.        |
| **Low**      | Limited-impact weakness or defence-in-depth gap with a demonstrated attack path.                                                          |

A completed review with no qualifying path reports **“No security findings.”**

---

## Maintaining this policy

Update this file when a change alters a protected asset, data class, threat actor, trust boundary,
accepted external risk, or security invariant. Implementing an already-documented invariant does
not require a policy edit.

OWASP ASVS 5.0.0, OWASP API Security Top 10 (2023), and OWASP Top 10 for LLM Applications (2025)
were used as completeness checks for technical controls, API isolation and resource abuse, prompt
injection, unsafe model output, excessive agency, and unbounded consumption. They are not
substitute finding sources, and this policy does not claim ASVS compliance.
