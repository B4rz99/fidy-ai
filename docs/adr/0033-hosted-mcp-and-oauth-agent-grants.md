# Hosted MCP and OAuth User-owned agents

- **Status:** Accepted (design only; interoperability and implementation gates remain open)
- **Date:** 2026-10-03
- **Issues:** [#33](https://github.com/B4rz99/fidy-ai/issues/33), [#977](https://github.com/B4rz99/fidy-ai/issues/977)
- **Supersedes:** only ADR 0016's exclusion of remote MCP and an OAuth authorization server.

## Context and evidence

The User selected hosted Streamable HTTP MCP and first-party browser authorization, not a local
Fidy connector or PAT copy/paste. OAuth is a distinct authority path. PATs and Hosted Agent
Sessions retain their existing meanings, scopes, expiration and Consent timing.

The [compatibility report](../research/hosted-mcp-interoperability-977.md) records exact versions,
source references, reproducible fixtures, successful synthetic exchanges and failures. This decision
accepts the architecture, **not** security or launch certification. The revised compatibility slice
passes for Claude Code 2.1.288 and Codex 0.160.0. Codex 0.144.1 is unsupported because its
callback drops issuer evidence; upgrading the tested host resolves this without weakening issuer
validation. Claude's earlier reconnect failure was a local profile-path mismatch. No production
authority, deployment, onboarding, provider
work or launch enablement is authorized by this ADR.

## Ownership and execution

The proposed resource is exactly `https://api.fidyapp.com/mcp`; the authorization issuer is
`https://api.fidyapp.com`. Deployment must publish those exact identifiers consistently; neither
request Host nor forwarded headers choose them.

Future owner publications follow ADR 0031:

- `core/oauth-agents/contract.ts` owns OAuthConnection, grant/credential identities, lifetimes and
  state declarations; `operations.ts` owns pure scope, expiration and rotation decisions.
- `shell/oauth-agents/contract.ts` owns browser-safe authorization and connection-management
  declarations; its operations own protocol-safe failure and disclosure projections.
- `cloudflare/oauth-agents/operations.ts` owns code exchange, live grant authentication, refresh,
  fresh-session browser approval and revocation; its runtime constructs bounded native adapters.
  Digests, registration records, D1 rows and evidence composition remain private.
- `shell/mcp` owns the catalog-derived protocol projection, not domain behavior. Its native runtime
  uses Effect's HTTP/protocol implementation and invokes published Canonical Operations under the
  existing User coordinator. OAuth browser and token transports are neither tools nor batch children.
- `cloudflare/oauth-confirmation` owns first-party pending/approved/consumed confirmation evidence.
  It lends a guarded, transaction-composable consumption to Canonical Operations, never a reusable
  permission. Hosted Agent confirmation remains privately hosted and cannot authorize OAuth work.
- Web `oauth-connections` owns approval, confirmation and settings presentation, deriving types
  from the browser-safe server declarations. It neither parses nor stores OAuth credentials.

Ingress retains no D1 binding. Private Core/D1 is authoritative, and the existing per-User Durable
Object serializes canonical work, refresh, confirmation and revocation. All protected D1 work
rechecks live authority inside its unit; an earlier admission or tools/list is not permission.
There is no second financial model, operation registry, quota meter, audit stream or inference path.

An explicit **OAuth User-owned-agent caller** contains stable UserId, OAuthConnectionId and safe
credential identity with approved capabilities. It is not a PAT, WebSession or Hosted Agent Session.
Canonical access policy treats it as a User-owned agent for `read`, `write`, `dashboard`, not as an
eligible account-security caller. Refactor the currently PAT-named capability requirement into the
shared User-owned-agent requirement when implementing; retain PAT lifecycle ownership separately.
Queries, mutations, nested batch alternatives and SuggestedOperations consume the same policy.

`tools/list` is authorization-private, canonical-ID ordered, initially `ttlMs: 0`, and derived from
canonical declarations including schemas, descriptions and confirmation metadata. Filter nested
batch and SuggestedOperation identities as well as top-level tools. Scope-eligible Pro tools may be
visible but return canonical `paywall_required`; allowance exhaustion stays `quota_exhausted`.
Success/failure envelopes retain structuredContent and meaningful text, retry information and valid
`next`. Decode outgoing values. Do not use stock toolkit failure mapping if it loses the canonical
envelope. A lost transport response never authorizes blind mutation retry.

## Discovery, registration and destinations

Implement RFC 9728 protected-resource metadata, RFC 8414 issuer metadata, authorization code flow,
PKCE **S256 only**, RFC 8707 resource indicators and RFC 9207 `iss` responses. Advertise issuer
response support and require exact issuer/resource binding. No token passthrough or alternate API
audience is accepted. The initial challenge requests `read`; protected-resource `scopes_supported`
is the minimal `read` set, not the full capability catalog. The AS may advertise the supported
capabilities but must not silently request or grant them. Omitted scope means read only; unknown
scopes reject.

Prefer Client ID Metadata Documents (CIMD): Claude Code 2.1.288 and Codex 0.160.0 selected their
host-owned documents when both mechanisms were advertised. DCR is not a client identity verification service and needs no client secret for native public
clients. Each registration binds exact redirect URIs and allowed code/refresh grants. Registration
never creates a User grant. CIMD selection is actual host evidence; production metadata retrieval
and authority security remain unimplemented and unproved. Pre-registration is a standards-compliant troubleshooting option, not the
primary add-URL experience and not a substitute for the host gate.

CIMD retrieval must extend the named Outbound HTTP publication deliberately, not use arbitrary
fetch in OAuth. Use HTTPS, no userinfo or fragment, maximum 2 KiB URL, 16 KiB actual streamed JSON,
three-second total deadline, no redirects, one fetch per authorization attempt, a bounded cache
(256 entries, five-minute maximum age), and at most four concurrent fetches. Validate owning Schema,
exact client_id and registered redirect metadata. Permit only explicitly reviewed launch-client
metadata origins and paths. Resolve and reject loopback, private, link-local, reserved and metadata
addresses, IPv4/IPv6 and mapped forms; prevent DNS rebinding by an enforceable outbound destination
policy. If the platform cannot guarantee this, CIMD fetching remains unavailable. Arbitrary URLs
are not a fallback. Failed metadata never grants authority.

Native callbacks may use HTTP only on registered loopback addresses. Compare scheme, host, path,
query and all other URI components exactly, with only the RFC 8252 loopback-port exception when
registered for a native client. No wildcard host/path, open redirect or caller-selected post-login
return URL. Production metadata and token transports use HTTPS. A localhost callback does not
make localhost an allowed CIMD destination.

Bound public discovery/registration/authorization/token bodies to 16 KiB, authorization attempts to
ten minutes, outstanding attempts to five per source and five per authenticated User, token work
to a five-second deadline, and registry entries to 10,000 with thirty-day unused expiry. Use existing
security admission with source and global budgets before public work, and stable-User budgets once
resolved. Reject before scheduling provider/model work. These bounds are initial fixed policy,
not proven availability evidence; downstream tests and capacity review remain mandatory.

## Browser approval and credential lifecycle

The first-party browser must establish an appropriately fresh WebSession using existing Fidy
proofs. Approval POST is origin/CSRF protected, bound to the exact same User, pending request,
registered client and redirect URI, resource, PKCE challenge, requested/approved scopes, disclosure
revision and absolute expiration. Public request references grant nothing. Cancel, expiry or an
empty subset creates no grant. Approval and code issuance append attributable Consent evidence in
the same D1 unit. Each approval creates a distinct OAuthConnection even for repeated client names.

Codes have a **60-second** usable lifetime after approval, at least 256 random bits, digest-only
storage and one-use exchange. Exchange atomically consumes the code and issues credentials after
checking client, redirect, resource, S256 verifier, User, current Consent and live approved grant.
Authorization callbacks alone cannot establish a Fidy session. Code-bearing callbacks have
no-store/referrer protections; logs never retain the URL or code.

Grant expiration is fixed at approval: **7/30/90/365 days**, default **90 days**, measured as absolute
UTC intervals. Access credentials expire at `min(issuedAt + 10 minutes, grantExpiresAt)`. Refresh
credentials expire at `min(issuedAt + 30 days, grantExpiresAt)`. Refresh inactivity may therefore
require browser reconnection before a long grant ends. Neither use nor rotation extends the grant.
Use opaque random credentials with digest-only persistence; only direct token responses disclose
raw credentials. Never emit them through tools, models, Fidy browser state, logs or ordinary errors.

Refresh rotation is serialized per User and commits compare-and-swap consumption of the current
refresh generation, issuance of the next digests, and metadata evidence atomically. It rechecks
client/resource/User, current Consent, grant revocation/expiration, refresh expiry and approved
scopes; it cannot escalate or switch subject. A recognized consumed credential is replay: revoke
that connection's entire refresh family and all access credentials in the same D1 unit, return
`invalid_grant`, append revocation evidence. Unknown credentials receive a bounded generic refusal
and cannot revoke another connection. With concurrent use, one exchange may win, but the losing
recognized replay revokes the family, including the winner's new credentials. There is **no grace
window and no cached raw replacement**. Lost responses require new browser approval, not replay.
Hosts must serialize refresh and retain rotations durably; prove this before launch.

Every canonical call rechecks current Consent and live credential/grant within its authoritative
unit, with scope, tier, shared User allowance and Audit. OAuth never borrows hosted next-Session
Consent timing. Terms changes follow User-owned-agent policy; explicit revocation blocks subsequent
work and refresh. Metadata-only AuditLogEntries carry stable User, OAuth connection/credential
identity, canonical operation, outcome and instant. OAuth grant/revocation Consent evidence is
append-only and separately identified, never masquerading as a PAT row.

Fresh-session settings can revoke one or all OAuthConnections. Revocation stops later calls and
refresh across all instances, not already committed work. Browser logout, PAT-wide revocation and
OAuth-wide revocation are distinct controls and independent lifecycles.

## Sensitive-operation handoff and resume

Ordinary authorized mutations need no repeated approval. Destructive/irreversible policy is derived
from canonical metadata, including each batch child. A host annotation, model assertion or an
elicitation `accept` response is never confirmation evidence.

1. An authorized sensitive invocation validates its canonical input and creates one pending intent
   for that User/connection. Store canonical encoded input privately, its cryptographic digest,
   canonical operation identity, applicable domain revision(s), disclosure revision, creation/expiry,
   original scope requirement and an unpredictable public reference. Maximum lifetime **five minutes**;
   maximum five outstanding intents per User; input bytes remain within canonical request bounds.
2. A supported host receives a protocol URL-elicitation/input-required continuation pointing only to
   `https://app.fidyapp.com/agent-confirmation/<public-reference>`. The reference identifies an intent,
   not a bearer or permission. Neither operation input nor credential is in the URL. The browser
   requires the same User's fresh WebSession. A different User receives no intent details.
3. The browser loads the server-owned exact operation/input/revision projection and explicit effect
   disclosure. An origin/CSRF-protected **Confirmar / Cancelar** POST approves only that immutable
   intent under live connection, scope and Consent. Browser approval does not execute the mutation.
4. The host resumes by explicitly repeating the same canonical operation and input under the same
   OAuthConnection with the public continuation reference in protocol metadata, not tool arguments.
   The owner checks exact decoded input digest and revisions, User, connection, expiry and approved
   single-use evidence. Consume evidence with all domain guards, mutation and Audit in the same D1
   atomic unit. A stale revision requires a new visible review; failure leaves no partial mutation.
   For a batch, bind the complete ordered batch and every sensitive child's revision; consume all
   required evidence with the whole batch or none. Never match merely by operation name.
5. Denial, missing/changed inputs, foreign subject/connection, expiration, replay or concurrent
   consumption refuses safely. A completed intent cannot execute again. An ambiguous response is
   reported as outcome unknown; do not automatically resume/retry a mutation. Reading committed
   outcome must use an owner-defined read, not cached authority.

This is a **planned** protocol projection, not an implemented Effect/host interaction. Capability
advertisement alone is insufficient: launch evidence must prove the exact host's browser handoff
and resume semantics, including secret-free model/transport boundaries. Until then sensitive
interactions for that host fail closed without retaining a executable approved intent. No custom
MCP method, parallel tool registry, form-collected secret, or hosted confirmation shortcut is allowed.

## Approved Spanish UX

One concise screen after sign-in shows the client's **claimed** name (unverified), requested
permissions, duration/expiration and **Conectar / Cancelar**. Only requested capabilities appear:
**Consultar tus datos**, **Crear y modificar tus datos**, **Ver y editar tu tablero**, with brief
shared disclosure facts. Deselecting to a narrower non-empty subset is allowed; adding an unrequested
capability is not. No implicit write. Escalation always starts a new explicit browser review and
creates a separately identifiable connection; it does not modify the old grant silently.

Compact duration selection offers 7/30/90/365 days, defaults to 90 and shows the resulting expiration.
Settings show safe short connection identity, claimed client name, approved permissions, expiration
and bounded metadata-only recent activity. Label **Revocar esta conexión**, **Revocar todas las
conexiones**, PAT controls and **Cerrar sesión** separately. Explain expiration/reconnection and
that revocation does not undo committed changes. No OAuth jargon or raw scope/token values are
required of the User. This ADR specifies copy, not a shipped UI.

## Gates and consequences

Pin Effect stable exactly; upgrade the workspace family coherently only in downstream work. Use
Effect's stateless 2026-07-28 adapter; the observed Codex 0.160.0 handshakes and
2026-only refusals justify only 2025-11-25 compatibility.
Remove unneeded older adapters; no second MCP SDK or hand-written wire implementation is approved.

Before production authority: implement and verify the new caller/access algebra, D1 atomicity,
negative public OAuth tests, two-User isolation, sensitive handoff, streamed bounds/cancellation,
revocation and refresh concurrency. Instrument bounded Work with metadata-only outcomes, never
credential-bearing URLs or protocol bodies. #35 must include OAuth in the existing shared User
allowance without duplicate metering or credential resets. Real ingress/Core/coordinator evidence,
full dependency verification, exact host reruns, synthetic release checks and explicit operator
launch approval remain mandatory. Failure of the compatibility matrix is not grounds for weakening
issuer/resource/confirmation policy.
