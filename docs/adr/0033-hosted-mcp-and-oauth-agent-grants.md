# Hosted MCP and OAuth User-owned agents

- **Status:** Accepted (OAuth and native confirmation implemented; production onboarding and launch gates remain open)
- **Date:** 2026-10-03
- **Amended:** 2026-10-05 — Claude Code/Codex-only support and accepted client-native confirmation authority; supersedes this ADR's original browser confirmation contract, not browser OAuth connection approval.
- **Issues:** [#33](https://github.com/B4rz99/fidy-ai/issues/33), [#977](https://github.com/B4rz99/fidy-ai/issues/977), [#988](https://github.com/B4rz99/fidy-ai/issues/988)
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

The User subsequently selected **Claude Code and Codex only**. Pi and OpenCode are no longer
supported targets; no adapter extension is required or approved for this slice. Earlier Pi findings
remain historical evidence, not current scope. The
[native confirmation report](../research/oauth-native-confirmation-988.md) records synthetic native
form accept/cancel journeys for Claude Code **2.1.289** and Codex **0.160.0**. Real canonical/Core/D1
confirmation is now implemented by #988. The [pinned-host implementation evidence](../../scripts/mcp/native-confirmation-hosts.evidence.json)
records real public ingress/coordinator/Core/native D1 accept, cancel and headless refusal for both
hosts, with Codex CLI and daemon pinned to **0.160.0**. Canned loopback model responses and
a disposable grant isolate confirmation; they do not verify production onboarding or human presence.

## Ownership and execution

The proposed resource is exactly `https://api.fidyapp.com/mcp`; the authorization issuer is
`https://api.fidyapp.com`. Deployment must publish those exact identifiers consistently; neither
request Host nor forwarded headers choose them.

Owner publications follow ADR 0031:

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
- `cloudflare/oauth-confirmation` owns server-validated pending/approved/consumed client-asserted
  confirmation evidence. It lends guarded, transaction-composable consumption to Canonical
  Operations, never a reusable permission. Hosted Agent confirmation remains privately hosted
  and cannot authorize OAuth work. MCP owns native protocol/UI projection, not approval persistence.
- Web `oauth-connections` owns initial connection approval and settings presentation, deriving types
  from the browser-safe server declarations. It neither parses nor stores OAuth credentials and
  does not own the native sensitive-operation review.

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
host-owned documents when both mechanisms were advertised. Bounded RFC 7591 public
Dynamic Client Registration (DCR) was necessary compatibility for the historically tested Pi 1.0.1,
which selected DCR under the same advertisement; Pi is now outside the supported matrix. Existing
DCR contracts are not removed by this confirmation decision and do not imply Pi support.
DCR is not a client identity verification service and needs no client secret for native public
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
from canonical metadata, including each batch child. Sensitive confirmation uses a server-requested
native MCP form in Claude Code or Codex, separate from initial browser OAuth connection approval
and local tool permissions. There is no browser detour, URL/repeat fallback, chat “yes”, extension,
private approval tool or host-name-based authority.

**Accepted trust boundary (User-approved 2026-10-05):** Fidy trusts the OAuth-authorized client's
native confirmation response as client-asserted approval for the exact server-owned intent. This
replaces the previous fresh same-User WebSession requirement for sensitive-operation confirmation
only. A modified client or host hook can fabricate/automate a valid acceptance without showing a
form or obtaining a human click; this risk is explicitly accepted. Neither protocol state, signatures,
capability advertisement nor a claimed host name independently attests human presence. Model
claims, arbitrary tool arguments, annotations and local tool permission still grant no confirmation.
Initial OAuth grants, scope escalation and connection management retain fresh first-party browser
authority and their existing origin/CSRF requirements; PAT and hosted confirmation are unchanged.

1. An authorized sensitive invocation validates its canonical input and creates one immutable
   pending intent for that User/connection. Store canonical encoded input privately, its cryptographic
   digest, canonical operation identity, applicable domain revision(s), disclosure revision,
   creation/expiry, original scope requirement and an unpredictable public continuation reference.
   Maximum lifetime **five minutes**; maximum five outstanding intents per User; input bytes remain
   within canonical request bounds. A reference alone grants no authority.
2. MCP projects the server-owned exact effect into one concise Spanish native form with a required
   affirmative confirmation and safe false default. The host owns native controls; identical Spanish
   button labels across hosts are not promised. No Secret enters model context, form fields or URLs.
   Waiting for the decision is bounded by the intent deadline and must not hold User coordination
   so as to block credential refresh, revocation or unrelated work throughout human review.
3. Decode the standard native form response and bind it to the issuing intent, same stable User and
   OAuthConnection under current authority. Only `accept` with explicit `confirm: true` may approve;
   decline, cancel, false/missing content, malformed responses or expiry authorize nothing. Retain
   only bounded, purpose-needed approval evidence; it records client assertion, not human attestation.
4. Resume through Effect's standard host/protocol semantics, not invented model arguments. Claude
   Code repeats unchanged arguments with top-level keyed `inputResponses` and `requestState`;
   default Codex answers native elicitation within the original legacy-protocol invocation. These
   pre-mutation continuations are not retries after uncertain execution. The owner checks exact
   decoded input digest and revisions, User, connection, expiry and approved single-use evidence.
   Consume evidence with live credential/grant, scope, Consent, domain guards, mutation and Audit
   in the same D1 atomic unit. A stale revision requires a new visible review; failure leaves no
   partial mutation or incorrectly consumed evidence. For a batch, review/bind the complete ordered
   batch and every sensitive child's effect/revision; consume all required evidence with the whole
   batch or none. Never match merely by operation name.
5. Denial, missing/changed inputs, foreign subject/connection, expiration, revocation, replay or
   concurrent consumption refuses safely. A completed intent cannot execute again. Cancellation
   cleans up pending work but cannot undo a committed mutation. An ambiguous response is reported
   as outcome unknown; do not blindly resume/retry a mutation. Reading committed outcome must use
   an owner-defined read, not cached authority.

This is an **accepted, implemented** protocol projection. Capability advertisement and synthetic
form success alone are insufficient: #988's pinned-host evidence exercises native accept/resume,
cancel and headless refusal through real canonical/Core/D1 execution. Ingress regressions cover
negative/malformed acceptance, exact binding, expiry, replay, concurrency, authority races, rollback
and bounded native waits. Tests distinguish untrusted model claims from valid client assertions,
including the accepted automation risk, without claiming independent human proof. Unsupported
native interactions remain refused. Production onboarding and operator launch approval remain open. No custom MCP method, parallel tool
registry, form-collected secret, hosted confirmation shortcut or browser fallback is allowed.

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
Effect's stateless 2026-07-28 adapter; the observed supported Codex 0.160.0 handshake and
2026-only refusal justify 2025-11-25 compatibility. The earlier Pi evidence does not expand scope.
Remove unneeded older adapters; no second MCP SDK or hand-written wire implementation is approved.

Before production authority: implement and verify the new caller/access algebra, D1 atomicity,
negative public OAuth tests, two-User isolation, sensitive handoff, streamed bounds/cancellation,
revocation and refresh concurrency. Instrument bounded Work with metadata-only outcomes, never
credential-bearing URLs or protocol bodies. #35 must include OAuth in the existing shared User
allowance without duplicate metering or credential resets. Real ingress/Core/coordinator evidence,
full dependency verification, exact host reruns, synthetic release checks and explicit operator
launch approval remain mandatory. Failure of the compatibility matrix is not grounds for weakening
issuer/resource/confirmation policy.
