# Security standards

The security standards for reviewing changes to Fidy. They describe the attack surface of the
planned product in issue #1, not only the code that exists today. They are deliberately narrower than
a security programme: every rule here must be decidable from a code or configuration diff and its
tests.

A review applies a rule only when the diff introduces, changes, exposes, or worsens that rule's
attack surface. An unbuilt future capability is not a finding. A pre-existing weakness is a finding
only when the diff newly exposes it, worsens it, or relies on it.

The review asks **what must remain secure**, not how to implement it. Issue #1, root
[`ARCHITECTURE.md`](ARCHITECTURE.md), and the application architecture documents for
[`@fidy/server`](apps/server/ARCHITECTURE.md), [`@fidy/web`](apps/web/ARCHITECTURE.md), and
[`@fidy/cli`](apps/cli/ARCHITECTURE.md) own
already-adopted mechanics; this document turns their security consequences into reviewable
invariants.

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
- Surviving a total compromise of Kapso, Resend, Wompi, Cloudflare, or another provider.

---

## Threat model

### Protected assets

1. **Secrets** — raw PATs, provider credentials, signing secrets, private device codes, recovery
   proofs, BackupRecoveryCodes, and protected-PDF passwords.
2. **Personal and financial data** — identity and recovery details, Transactions and
   SourceAttestations, Budgets, Categories, DashboardDocuments, Subscriptions and BillingAttempts,
   Transcripts, CompactedConversations, Memories, NeedsReviewItems, and raw IngestSamples.
3. **Security evidence** — ConsentRecords, AuditLogEntries, PAT grants and revocations, support
   recovery decisions, origin-qualified decision evidence, and immutable interpretation or policy
   revisions.
4. **State integrity** — User ownership, caller scope, consent state, financial records, billing
   state, InsightEvent lifecycle, and retention/anonymisation state.
5. **Availability and spend** — request, parser, queue, model, messaging, and billing-provider
   capacity whose abuse can deny service or create unbounded cost.

### Threat actors and failure sources

- An unauthenticated internet attacker.
- A User, or one of their agents, attempting to reach another User's data or operations.
- A holder of a stolen, revoked, expired, replayed, or under-scoped bearer credential.
- A sender forging or replaying Kapso, Cloudflare Email, Wompi, or queued work.
- Malicious instructions embedded in messages, emails, statements, images, receipts, Memories, or
  provider/model output.
- Accidental disclosure through logs, errors, URLs, browser state, transcripts, caches, or outbound
  provider payloads.
- Malformed or adversarial data returned by a provider, parser, model, database row, or queue.

### Trust boundaries

Every crossing is untrusted regardless of its TypeScript type or vendor:

- public HTTP, the SPA, browser-login pairing, and PATPairing flows;
- Kapso, Resend, Wompi, Workers AI, and other outbound or callback seams;
- PAT, hosted-agent, CLI, MCP, and typed-client calls;
- LLM prompts, tool requests, structured output, and generated presentation content;
- emails, PDFs, CSV/XLSX files, images, voice transcripts, and screenshots;
- D1 rows and JSON values, queue payloads, schedules, migrations, and environment configuration.

### Data handling classes

| class                     | review invariant                                                                                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Secret**                | Once handled through an intended Secret boundary, exists only for its required lifetime and purpose. It does not enter logs, errors, analytics, transcripts, LLM context, broad application objects, or recoverable storage unless recovery is the security requirement. |
| **Personal or financial** | Access is bound to one explicit User and purpose. Persistence, model context, logs, and provider egress contain only what that purpose needs.                                                                                                                            |
| **Security metadata**     | Only the approved identity, token id, operation, outcome, timestamp, and provider evidence needed for accountability are recorded. Metadata must not become a disguised request body.                                                                                    |
| **Public**                | May be exposed intentionally, but still receives integrity, output-encoding, and cache review where it can influence trusted behaviour.                                                                                                                                  |

---

## Review invariants

Each section states when it applies, what must hold, and the evidence a reviewer should seek. The
examples are representative, not an exhaustive checklist.

### Surface applicability

This root policy owns shared invariants, accepted exceptions, and required security evidence.
Application architecture documents own implementation mechanics and test seams. Read every invariant
whose `Applies when` clause matches the diff; the table is navigation, not an exemption for an
unlisted surface. Follow a boundary across applications rather than stopping at the changed directory.

| Surface         | Particular concerns                                                                   | Common sections | Mechanics and test seams                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web             | Browser authority, origin/CSRF, rendering, caches and static delivery                 | 1–4, 8–10       | [Web architecture](apps/web/ARCHITECTURE.md)                                                                                                                     |
| Server / API    | User isolation, canonical authorization, validation, atomicity and provider trust     | 1–5, 8–10       | [Server architecture](apps/server/ARCHITECTURE.md)                                                                                                               |
| Hosted agent    | Model context, tool authority, exact-action confirmation and bounded execution        | 1–4, 6, 8, 10   | [Hosted execution](apps/server/ARCHITECTURE.md#6-hosted-execution-and-delivery)                                                                                  |
| CLI             | Native credential store, fixed origin, file/stdin input, diagnostics and local logout | 1–4, 8–10       | [CLI architecture](apps/cli/ARCHITECTURE.md)                                                                                                                     |
| MCP             | OAuth grants, scope-private discovery, tool execution, confirmation and replay        | 1–4, 6, 8–10    | [Server architecture](apps/server/ARCHITECTURE.md#hosted-mcp-and-oauth-development-authority) and [ADR 0033](docs/adr/0033-hosted-mcp-and-oauth-agent-grants.md) |
| Ingestion       | Hostile bytes, parser output, retention and model/provider egress                     | 3, 4, 6–8, 10   | [Server architecture](apps/server/ARCHITECTURE.md)                                                                                                               |
| Background work | Authenticated callbacks, User-bound queues, retries and schedules                     | 1, 3–5, 8–10    | [Background execution](apps/server/ARCHITECTURE.md#7-background-execution-and-availability)                                                                      |
| Infrastructure  | Public exposure, private bindings, runtime privileges and edge policy                 | 1, 8–10         | [Production boundary](ARCHITECTURE.md#production-boundary) and [stack](infra/cloudflare/alchemy.run.ts)                                                          |

MCP and the hosted agent are server-owned surfaces, not separate applications. Browser approval and
server execution remain one reviewed authority boundary. Add an application-specific security
supplement only when substantial unique invariants need their own reference; link it here and keep
shared requirements authoritative in this file.

### 1. Authentication, authorization, and User isolation

**Applies when:** a diff adds or changes an operation, caller resolver, repo query, object lookup,
cache, background path, scope, suggested operation, or User-owned model.

**Invariant:** access is deny-by-default. Every canonical operation and data path resolves an
explicit stable `UserId` and an applicable access policy, except a deliberately named public entry
point that verifies its own proof. Phone numbers, provider ids, message ids, object ids, and model
claims are evidence or input, never authority.

The private Core data API replaces PostgreSQL RLS for canonical User data: public ingress has no
D1 binding, every User-owned read or mutation carries an explicit `UserId`, and pre-subject lookups
are narrowly scoped. The private Email Worker has a separate, narrow D1 admission and retention
boundary; it cannot treat a sender or receipt as User authority. Possession of an opaque UUID does not confer access. Each canonical operation declares one access requirement: a PAT scope for domain operations or an
eligible caller class for account-security operations. It governs HTTP
authorization, MCP/tool visibility, CLI availability, hosted-agent calls, and suggested operations.
The hosted agent uses the same authorization path as the User's own agents.

A non-request path that reads User data crosses the private data boundary. Its diff must prove
isolation beyond the request-derived API test. Queue work, caches, schedules, retries, and model
context must not mix Users.

**Evidence:** trace the subject and policy from entry point through the private data API; inspect
all object-id reads and writes; verify an under-scoped caller cannot invoke or discover the
operation. At each applicable request, coordinator, Queue, Workflow, schedule, R2, and model-context
seam, use two distinct Users to prove B cannot observe or alter A, including no partial effects on
rejection.

**Violation examples:** a repo accepts `TransactionId` without `UserId`; a worker loads every due
InsightEvent and loses the subject before delivery; a tool is hidden from MCP but remains callable
over HTTP; an affordance advertises an operation the token cannot invoke.

### 2. Credential and recovery lifecycle

**Applies when:** a diff handles PATs, Hosted Agent Sessions, web sessions, browser-login pairing,
PATPairing, recovery, revocation, or WhatsAppIdentity changes.

**Invariant:** bearer material is unpredictable, narrowly purposed, bounded in usable lifetime,
and disclosed only through its intended one-time channel. Verification does not require retaining
recoverable bearer material when a digest suffices. Use, expiry, revocation, and replay are decided
at the authoritative boundary and take effect across every client surface.

The Bun CLI's local native credential store is a narrow recoverable-bearer exception for
subsequent authenticated calls by the same OS User. The server remains digest-only. This exception
requires a fixed production origin, redacted application values, the native OS provider only, and
Windows local-machine persistence verified against the pinned runtime; file/environment fallbacks,
URLs, browser state, arguments and diagnostics are not bearer-storage channels. Local logout removes
saved access without asserting server revocation.

Google and Microsoft signup, on the web or through WhatsApp, require a ProviderCredential keyed by the validated canonical issuer
and subject. WhatsApp-led signup additionally requires accepted originating-chat Consent and explicit confirmation of the exact reviewed association from that authenticated caller. Contact email never establishes identity, merges Users, creates a VerifiedEmailCredential,
or substitutes mailbox ownership proof. Missing/changed email claims preserve the same User.
A VerifiedEmailCredential is globally unique after
trim-and-lowercase normalization; provider-specific dot or plus-address folding is not proof of
equivalence. The credential may approve BrowserLoginPairing for ordinary email login or recovery to
its existing UserId but never becomes User identity or direct session authority. Replacement proves
the candidate before atomically removing the old credential. Email authentication and support
recovery never create a User, mint a parallel session, substitute a newly supplied credential, or
change WhatsAppIdentity. The pairing's browser-private verifier remains independently required.

Provider OIDC requires signature, issuer, nonempty subject, intended audience, expiry, issued-at,
state, nonce, and S256 PKCE validation within the same bounded browser-bound attempt. The provider
PKCE verifier is confined to an API HttpOnly/Secure/SameSite=Lax cookie and token exchange; only
its digest is retained. The Browser Login verifier stays in mounted memory and independently proves
initiation, status, completion, and redemption. Claim the callback before exchange; never retry an
uncertain code exchange. Provider tokens are used transiently and never persisted or exported.
Request only `openid email`. Provider verification approves the initiating pairing; only Browser
Login mints a session. Signup commits all owner records and proof consumption together; concurrent
or stale consumption rejects. Returning authentication does not reinstate withdrawn Consent.
Authorization codes cross only their exact `/providers/google/callback` or `/providers/microsoft/callback`; the callback immediately returns a
no-store/no-referrer 303 to a parameter-free first-party page. Automatic Worker invocation logs are
disabled; application/provider telemetry must exclude URLs, bodies, tokens and claims. Edge log
products and tail consumers must also exclude callback query strings before real provider use.
Lost recovery responses cannot be redisclosed or recreated through completion replay. A fresh provider
login can prove established ownership after an ambiguous signup, while ordinary work retains live
Consent checks. Expired provider protocol state is removed after one day.

WhatsApp handoff references and review identifiers are public correlation, never credential or session authority.
Bind one ten-minute attempt to the authenticated Business Portfolio/BSUID, business phone endpoint and one
browser-private pairing. An originating chat must receive the selected provider account and matching
browser review identifier, then reply to that exact native review message with an explicit confirm/deny.
Opening or forwarding a reference cannot confirm an association. Recheck the accepted exchange, exact
pairing, live confirmation and initial-association uniqueness in the completion batch; consume once.
Existing provider Users retain their UserId, Consent, TrialPeriod and recovery credential. Initial linking
refuses any established channel association, never replaces it. Chat sends claim once before provider I/O;
ambiguous results never resend. Charge each send against the bounded native spend policy before egress.
Required negative evidence covers forwarded browser substitution, caller/reply mismatch, denial, expiry,
replay/concurrency, conflicts, rollback and ambiguous delivery, through authenticated ingress/Core/D1.
Pre-User handoff state is erased with its expiring Consent exchange; durable legal evidence remains.

Microsoft accepts personal and work/school accounts from all public-cloud Entra tenants by explicit
User decision in #1090. The common v2 authority is initiation policy, never a wildcard issuer.
Validate a GUID `tid`, exact `https://login.microsoftonline.com/{tid}/v2.0` issuer, v2 token version,
intended single audience and every selected signing key's issuer scope before trusting subject.
Bind callback, status and completion to the attempt's selected provider. Email and preferred_username
are optional contact/display claims; neither links another credential nor proves mailbox control.
No tenant-selected URL, custom signing-key application, B2C authority or sovereign-cloud host is fetched.

Browser authentication state must resist theft, fixation, cross-origin use, and leakage through
URLs, referrers, scripts, caches, or diagnostics. Known and unknown email-authentication attempts
share a bounded non-enumerating response. A BackupRecoveryCode is disclosed once, stored only as a
digest,
and consumed by an approved tracked support decision. Support does not infer ownership from identity
documents, financial facts, email, phone, or free-form operator judgment; loss of every established
proof ends recovery.

**Evidence:** follow the raw credential from creation through delivery, storage, verification,
rotation/revocation, and destruction; test reuse, expiry, revocation, wrong purpose, wrong scope,
wrong browser verifier, concurrency, and cross-User substitution.

**Violation examples:** a raw PAT is stored outside the approved local native credential store or pasted into chat; a private PATPairing device code
crosses Kapso; a recovery proof appears in a URL or Transcript; changing a phone number creates a
new owner for old data; support approves ownership from a bank statement.

#### Hosted MCP OAuth authority (bounded development slices installed; not launch-enabled)

When implementing ADR 0033, OAuthConnection is distinct User-owned-agent authority, never a PAT,
WebSession or Hosted Agent Session. Each call and refresh rechecks live grant, credential, audience,
client, stable User, approved non-empty capabilities and current Consent at its authoritative unit.
The reviewed absolute 7/30/90/365-day expiration is immutable; finite access/refresh lifetimes cannot
extend it. Browser logout, PAT revocation and OAuth connection revocation remain independent.

Initial OAuth connection approval requires the same User's fresh first-party session and origin/CSRF protection, bound to
exact client, registered redirect, resource, S256 challenge, scope subset and expiration. Omitted
scope means read only; escalation requires new explicit approval. Code exchange is short-lived,
single-use and atomic. Issuer/resource/redirect substitution or missing/wrong PKCE rejects without
partial authority. Client metadata and host names are unverified claims, not identity.

Refresh atomically rotates digest-only credentials under current authority. Recognized replay
revokes that connection's entire credential family, including a concurrently issued winner; there
is no grace interval or recoverable replacement-token cache. Unknown credentials cannot revoke
another connection. Expired or revoked authority cannot refresh or execute on another instance.
Metadata retrieval requires bounded streamed bytes, deadlines, concurrency and enforceable SSRF/DNS
rebinding protection; arbitrary URLs and redirect chains are not compatibility fallbacks.

Sensitive operations, including batch children, require OAuth-specific client-asserted confirmation
bound to the same stable User/OAuthConnection, exact operation, input digest, applicable domain and
disclosure revisions, original scope requirements and short expiry. The accepted authority is the
OAuth-authorized client's standard native form response to an immutable server-owned intent, decoded
and validated by Fidy: `accept` with explicit `confirm: true`. Public references/state alone, model
claims, arbitrary tool arguments, host annotations, local tool permissions and hosted-only evidence
grant no confirmation. Decline, cancel, false/missing content and malformed responses authorize nothing.

**Accepted risk (#988, 2026-10-05):** a modified authorized client or host automation/hook may assert
valid acceptance without human presence or displaying a form. Fidy does not independently attest a
human click and must not claim otherwise. This exception is limited to sensitive OAuth operations;
initial browser OAuth approval, scope escalation, connection-management fresh-session protection,
PAT and hosted confirmation contracts are unchanged. Claimed client names/capabilities are not
verified identity; the supported Claude Code/Codex matrix is not a security allowlist.

Consume evidence once in the same atomic unit as live credential/grant, scope, Consent, domain
guards, mutation and Audit. Bind/review the complete ordered batch and corresponding sensitive
children's effects/revisions; consume all required evidence with the whole batch or none. Failed
commits leave no partial effect or incorrectly consumed evidence. Wrong subject/connection,
changed input/revision, expiry, revocation, replay and concurrent consumption reject. Bound pending
intents and waits under ADR 0033; do not block User coordination throughout native review.
Unsupported native interaction and non-interactive modes without the required decision fail closed,
with no browser/chat fallback or blind retry after ambiguous mutation delivery.
Raw access/refresh credentials never enter Fidy browser state, URLs, models, tools or diagnostics;
authorization codes cross only the validated no-store/referrer-protected callback. Downstream tests
must prove replay/concurrency, cross-User substitution, issuer/resource/redirect/PKCE refusal,
CSRF, hostile metadata fetching and absence of partial effects at the real public/Core seam. A
synthetic exchange is not this security evidence.

### 3. Consent, privacy, retention, and egress

**Applies when:** a diff touches onboarding, consent, ingestion, transcripts, memory, retention,
anonymisation, provider payloads, reporting context, or personal-data deletion.

**Invariant:** before onboarding Consent acceptance, Fidy performs no financial processing, answers
no finance question, and persists no personal content beyond what is strictly required to present
and record the pending decision. Acceptance permits the bounded first-party provider handoff,
provider-account authentication and originating-chat association review. No stable User, WhatsAppIdentity,
ConsentRecord, Transcript or financial processing exists until provider verification and exact chat
confirmation atomically complete onboarding. Contact email is optional and creates no mailbox credential. Consent and revocation evidence is tied to the stable User and retains the exact historical
context needed to remain interpretable.

Explicit Consent revocation does not block authentication needed to reach Fidy-owned
re-consent and data-rights surfaces. It continues to block ordinary canonical work. Personal and
financial data is collected, retained, loaded into model context, and sent to a provider only for an
explicit current purpose. Outbound payloads are projections of what the
recipient needs, not broad domain objects. Current User preferences never reinterpret historical
consent, ingestion, billing, schedule, delivery, or persisted-report artifacts.

Raw ingestion material has enforced bounded retention. Indefinite structural samples qualify only
after anonymisation removes identifying and transaction-specific values. Protected-PDF passwords
are transient Secrets. Fidy never solicits bank credentials or card/account numbers in chat and
warns Users not to submit them.

Fidy does not classify or censor arbitrary free text by semantic content. Determining completely
and soundly whether open-ended prose contains a credential, financial identifier, protected
attribute, temporary detail, canonical-record fact, or other sensitive material is not an
enforceable security control. User-submitted free text follows its explicit Transcript, Memory,
Compaction, and hosted-model purposes and may therefore contain values the User should not have
submitted. The
hosted agent never solicits credentials, tokens, passwords, card numbers, account numbers, or
unnecessary sensitive personal data and warns Users not to submit them. Typed Secrets crossing an
intended credential boundary remain excluded from those purposes. Logs, telemetry, errors, and
AuditLogEntries remain allowlisted and never record free-text bodies.

**Evidence:** compare each collected or outbound field to its purpose; inspect pre-consent effects;
trace retention and anonymisation states; verify deletion/expiry is executable and tested rather
than documentary.

**Violation examples:** creating a User before provider verification and required originating-chat confirmation;
forwarding an entire transcript when one message is needed; keeping raw emails indefinitely because
anonymised fixtures also exist; saving a PDF password in the transcript.

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
model-produced Counterparty into SQL; rendering model Markdown with active HTML; decoding a queue job
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
influence model planning, but do not grant identity, scope or cross-User access and cannot substitute
for the caller's required exact-action confirmation. One deep hosted runtime privately owns each
admitted Turn's handlers and canonical execution state; none can escape its structured workflow.
Exact confirmation under the caller's approved authority contract is required when canonical
operation metadata marks an effect as destructive or irreversible. OAuth-native client assertions
use section 2's explicit accepted trust boundary: model claims alone cannot approve, but valid
client/hook acceptance is trusted without independent human attestation. Do not claim resistance
to deliberate client automation as a guarantee of this boundary.
Canonical operations independently enforce identity, capability, paywall, validation, and domain
rules on every call. Consent is the one check hosted work resolves per Turn rather than per call:
Hosted Agent Session admission and the per-Turn session recheck own hosted Consent timing, so a
revocation that commits mid-Turn stops the next Turn rather than the remaining calls of the current
one, and the exposure is bounded by one Turn's model rounds and tool-call budget. PAT calls stay
linearized with their own consent check under the subject lock.

The model receives only the operations and data needed for the current User and turn. It has no
private, open-ended, shell, SQL, arbitrary-file, or arbitrary-network capability. Hidden-context
secrecy is not a security boundary: system and developer instructions, tool schemas, retrieved
context and intermediate model material confer no authority. Fidy-managed Secrets stay outside
model-visible context; credentials required by a tool remain inside its independent executor.

Context assembly, CompactedConversations, caches, tool results, and Transcripts stay User-isolated.

**Evidence:** trace identity, scope, and destructive authority independently of prompt
instructions; compare exposed tools with canonical operation metadata; inspect context selection;
use adversarial direct, indirect, and multimodal fixtures to prove cross-User access and
unconfirmed destructive effects fail.

**Violation examples:** trusting the model to decline a write for a read-only token; an emailed
instruction causing the agent to call another User's operation; a CompactedConversation from one
User entering another User's turn.

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
canonical failure contract, never those values, stacks, database statements, parser dumps, provider
bodies, or internal topology.

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
database error; placing a provider credential in generated OpenAPI; upserting a revocation over the
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

**Violation examples:** credentialed `Access-Control-Allow-Origin: *`; a recovery token forwarded
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

Keep implementation mechanics in the owning architecture document or ADR; retain the invariant,
accepted exception, and required evidence here. Update the surface table and OWASP mapping when
those boundaries change.

## OWASP references and coverage

OWASP is a completeness check for this policy, not a substitute finding source or a claim of
compliance. A review finding still meets the [finding standard](#finding-standard). The mappings
below identify policy coverage, not verified implementation coverage; each changed boundary still
requires its negative evidence. They do not import every upstream recommendation as a Fidy rule.

### Pinned references

| Reference                                                                                                       | Pinned edition                  | Purpose                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [Application Security Verification Standard](https://github.com/OWASP/ASVS/tree/v5.0.0)                         | 5.0.0                           | Detailed technical control reference; no ASVS level or requirement-by-requirement conformance is asserted.                            |
| [Web Top 10](https://top10.owasp.org/2025/)                                                                     | 2025                            | Web, backend and runtime risks.                                                                                                       |
| [API Security Top 10](https://api-security.owasp.org/editions/2023/en/0x11-t10/)                                | 2023                            | API authority, business-flow abuse and external API consumption.                                                                      |
| [LLM Applications Top 10](https://genai.owasp.org/download/56857/?tmstv=1785822482)                             | 2026                            | Model input, output, context and agency risks.                                                                                        |
| [Agentic Applications Top 10](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) | 2026                            | Agent execution and authority risks; applicability compared on 2026-10-12.                                                            |
| [MCP Top 10](https://owasp.org/projects/mcp-top-10?tab=top10)                                                   | 2025 beta, consulted 2026-10-13 | MCP transport, tool and context risks. The upstream roadmap still labels this list beta; same-year revisions also require comparison. |

The [2026-10-13 reference reconciliation](docs/research/owasp-reference-verification-2026-10-13.md)
records the LLM 2025 → 2026 crosswalk and changed mitigation scope. The linked official 2026
artifact retains publication-date placeholders and the general landing page still says 2025;
this policy pins the linked artifact, not an inferred final publication status. LLM identifiers below
use 2026. Before replacing an edition, compare changed categories and mitigations, record their
applicability and disposition, and update affected invariants and evidence together.

The [implementation evidence assessment](docs/research/owasp-implementation-evidence-1260.md)
records category-specific controls, negative tests, test results and outstanding requirements.
Its scoped evidence does not establish an ASVS level, eliminate accepted risks, or authorize launch.

### Risk-to-policy mapping

IDs use the editions above. **Covered** means the named invariant addresses the applicable security
consequence. **Other gate** identifies a separate owner. **Partial** records a coverage limit or
accepted exception. **Not applicable** names an absent capability and must be revisited if introduced.
An applicable risk with no invariant or other owner is a **gap**: record the missing requirement and
track remediation in a GitHub issue rather than marking it covered. This mapping is a policy
comparison, not a code audit or a complete ASVS assessment.

| Reference / risk IDs                   | Surfaces                                          | Disposition and policy sections                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web A01, A07                           | All caller surfaces                               | Covered: identity, User isolation and credential lifecycle (§§1–2).                                                                                                                                                                     |
| Web A02                                | Web, server, infrastructure                       | Covered: explicit exposure and fail-closed configuration (§9).                                                                                                                                                                          |
| Web A03; API supply-chain dependencies | Build and distribution                            | Other gate: dependency/image/action SCA and freeze policy under [Scope](#out-of-scope); see [CI](.github/workflows/ci.yml) and [dependency gate](scripts/check-dependency-updates.ts). Runtime trust remains reviewable under §§4–5, 9. |
| Web A04                                | All data and credential surfaces                  | Covered: secret lifetime, protected storage and transmission boundaries (§§2–3, 8–9).                                                                                                                                                   |
| Web A05, A08                           | Server, web, ingestion                            | Covered: interpreter boundaries, authenticated effects and evidence integrity (§§4–5, 7–8).                                                                                                                                             |
| Web A06, A10                           | All surfaces                                      | Covered for this review scope: threat boundaries, atomic rejection, safe failures and bounded work (§§1–10 and required evidence).                                                                                                      |
| Web A09                                | Server, clients, infrastructure                   | Partial: security evidence and safe diagnostics (§8); see the operational response procedure and outstanding live evidence in the implementation assessment.                                                                            |
| API1, API2, API3, API5                 | API, CLI, MCP, hosted agent                       | Covered: User/object/property/function authority and credential checks (§§1–2, 4).                                                                                                                                                      |
| API4, API6                             | API and downstream work                           | Covered: authorized business effects, replay controls and stable-User cost bounds (§§1, 5, 10).                                                                                                                                         |
| API7, API8, API9, API10                | Server, MCP, infrastructure                       | Covered: bounded destinations, hostile provider responses and intentional exposed contracts (§§2, 4–5, 9–10).                                                                                                                           |
| LLM01, LLM03, LLM08, LLM10             | Hosted agent, ingestion, generated web content    | Covered: untrusted instructions/output, independent tool authority and exclusion of Secrets from prompts (§§1–4, 6–7).                                                                                                                  |
| LLM02, LLM06                           | Hosted agent and provider egress                  | Covered: purpose-bound data and bounded model/tool spend (§§3, 6, 8, 10).                                                                                                                                                               |
| LLM04; ASI04; MCP04                    | Agent/MCP dependencies and runtime tools          | Other gate for dependency compromise: SCA/freeze policy above. Covered for runtime authority and tool/context trust: §§1, 4, 6, 9. Total provider compromise remains out of scope.                                                      |
| LLM05, LLM09                           | Model training, retrieval, hosted context         | Partial: hostile ingested/context data is covered (§§4, 6–7). Fidy-owned model training and vector/embedding stores are not current declared capabilities; reassess their specific controls if introduced.                              |
| LLM07                                  | Hosted agent and generated financial presentation | Partial: model output cannot establish trusted authority (§§4, 6). Financial correctness and the Asesoría boundary belong to Spec review; this policy does not guarantee factual model output.                                          |
| ASI01, ASI02, ASI05, ASI06, ASI10      | Hosted agent, tools, Memory and Transcript        | Covered: independently enforced authority, inert output, isolated context and bounded execution (§§1–4, 6–8, 10).                                                                                                                       |
| ASI03                                  | Hosted and User-owned agents                      | Covered: caller-specific authority and credential lifecycle (§§1–2, 6).                                                                                                                                                                 |
| ASI07                                  | Agent communication                               | Partial: external agent calls cross authenticated API/MCP boundaries (§§1–2, 4–6). Autonomous peer-agent delegation is not a current declared capability; reassess if introduced.                                                       |
| ASI08                                  | Hosted agent and background work                  | Covered: atomic effects, failure containment and bounded retries/work (§§5–6, 8, 10).                                                                                                                                                   |
| ASI09                                  | Confirmation and generated presentation           | Partial: exact-action confirmation and safe presentation (§§2, 4, 6). OAuth client-asserted confirmation retains §2's accepted risk; it does not attest human presence.                                                                 |
| MCP01, MCP02, MCP07                    | MCP and browser OAuth approval                    | Covered: token lifetime, immutable grants, audience/scope and current authority (§§1–2, 8).                                                                                                                                             |
| MCP03, MCP05, MCP06, MCP10             | MCP tools and context                             | Covered: canonical tool declarations, hostile inputs/output and User-isolated context (§§1, 3–4, 6).                                                                                                                                    |
| MCP08                                  | MCP activity and diagnostics                      | Partial: metadata-only security evidence (§8); the implementation assessment distinguishes tested monitoring from outstanding security alerts and live response evidence.                                                               |
| MCP09                                  | Server deployment and external hosts              | Partial: intended Fidy exposure and private authority (§§1–2, 9). Inventory/governance of servers outside Fidy's deployment is outside this policy.                                                                                     |

CLI and backend coverage follows their actual boundaries in the surface table; a separate CLI or
generic server Top 10 is not required. Supply-chain gate ownership does not establish protection
against every malicious dependency, and a mapping never expands an accepted exception into a
stronger guarantee.
