# Web architecture

This document owns the internal architecture of `@fidy/web`. Read the repository
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) first for system shape, cross-application contracts,
production topology, and browser-to-server ownership.

---

## 1. Application shape

`apps/web` is the `@fidy/web` React/Vite application package and produces a portable static artifact.
It owns browser routing, providers, styles, and public policy copy. Its only server import is the
browser-safe `@fidy/server/client` declaration seam; it never imports server implementations. The API
Workers do not serve web routes or static assets.

Effect Atom derives browser transport from the assembled `FidyApi` with
`AtomHttpApi.Service()("FidyClient", { api: FidyApi, httpClient: ... })`. A shared browser HTTP policy
layer bounds and sanitizes that transport beneath each generated client; the web application does not
hand-wrap endpoints or declare a second canonical surface. Only GET/HEAD transport failures retry
once. Canonical requests may additionally retry a decoded `ResourceLimited` refusal with bounded
`Retry-After` pacing (six retries, delays of one to five seconds) inside the original 15-second
deadline. This proves non-admission; commercial exhaustion, uncertain mutations, authentication,
and enrollment refusals never gain automatic replay. Cancellation interrupts pacing as well as
in-flight transport. Shared and server state belongs to Effect
Atom, navigation state to TanStack Router, and irreducible one-component interaction state to React.

## 2. Behavioral ownership

The web application is organized by behavioral ownership rather than route visibility. Marketing,
audience, company, and legal pages form one public website surface because they share presentation
and lifecycle. Publicly accessible flows with independent product behavior, such as login, pairing,
or onboarding, remain separate features.

Presentation shapes derive from the canonical server declaration, the dedicated server-declared
hosted Turn browser API, or web-owned view state. `/app/agent` renders a proposed reply before the
User explicitly confirms receipt; until the receipt succeeds it never labels the Turn Completed.
The reply and one-use receipt stay in mounted component state, not browser storage or a URL. This
channel is not a tool-callable canonical operation and uses the same origin-locked, no-store,
redirect-rejecting, bounded browser HTTP policy as the derived clients. The
web does not maintain copied canonical schemas, operation maps, or access policy. The Pro payment flow
is browser-mediated: method-specific card, Nequi and DaviPlata authorization goes directly to Wompi
and shares Price, Consent and payment status views. A separate server-declared availability GET,
owned by the session's Effect Atom registry, advertises DaviPlata only when operator activation and
reviewed exact OTP destinations allow it. Availability is not a canonical operation, a browser
activation switch, or a chatbot activation path; preparation still enforces the server's one-source
restriction. Missing or failing availability does not advertise DaviPlata.

The DaviPlata form visibly supports only cédula de ciudadanía (CC). Document/product drafts and
OTPs remain React-local and travel directly to Wompi, never in Fidy payloads, browser storage, URLs,
or shared atoms. The form retains its opaque challenge in a mounted ref; the gateway and transport
closures enclose rotating, one-use bearer authority and the approved token. Only safe interaction
state and selection locks can enter shared view state. The transport independently verifies the
exact operator-reviewed destinations against the prepared merchant environment, bounds requests,
responses, attempts and the absolute authorization lifetime, and serializes actions. Unmount,
explicit cancellation or authentication-lifetime revocation abort pending requests/readers and
clear retained secrets and authority; authorization expiry also revokes the provider closure.

An uncertain authorization stops rather than blindly replaying an OTP mutation. Only an explicitly
eligible uncertain Fidy submission can use `retrySubmission`, while its approved token remains in
mounted memory. This reuses the stable `PaymentRequestId` without replaying tokenization, OTP
validation or a provider source POST. `confirm` is exclusively an OTP action. Reload cannot recover
the challenge, OTP or approved token, and the UI does not claim otherwise. Authorization is transient
and bound to the mounted form and authentication lifetime; the enrollment client is synchronously
revoked when that lifetime ends.
The web submits through the server-owned payment boundary and observes only browser-safe
`BillingAttempt` state through a canonical query;
provider references are not part of web application state.

### Dashboard first use

The authenticated Dashboard's Effect Atom owner explicitly reads the canonical view, initializes
only on the owner-declared `DashboardUninitialized` failure, then reads again. It exposes workflow
phase feedback without copying server state into React. Initialization and second-read failures are
presented truthfully; unavailability never triggers creation, and a load makes at most one
initialization attempt. Concurrent tabs rely on canonical initialization idempotence. Successful
edits invalidate the same Dashboard resource; queries themselves never create or repair domain state.
See [ADR 0032](../../docs/adr/0032-explicit-dashboard-creation-and-canonical-queries.md).

## 3. Browser authentication

Provider web signup/login begins at `/auth/google` or `/auth/microsoft`, discoverable from the public site.
The mounted Provider Authentication feature owns its private pairing proof, one-time recovery view,
and provider popup. It uses the generated authentication client: accept the exact disclosure revision,
initiate the selected provider, poll proof-bearing status, submit completion once, save recovery, then redeem through
Browser Login. No provider token or protocol code reaches the feature. `/auth/google-return` or `/auth/microsoft-return` closes
the popup at a parameter-free URL; existing opener isolation remains intact. Cancellation, timeout
and uncertain completion discard private proof and explain fresh sign-in; no mutation auto-retry or
recovery redisclosure. Authentication can succeed after Consent withdrawal while ordinary work
remains gated. Personal and work/school Microsoft accounts are accepted; channel-provider linking remains a subsequent slice.

The preserved channel/mailbox Browser Login begins at `/auth/pair`. The browser retains the private verifier while WhatsApp
approval, email authentication, or support recovery receives only its intended public proof. Public
references cannot establish a session, and pairing material does not enter URLs, unrelated browser
state, or static artifacts.

The web uses the server's canonical authentication paths and session authority. It does not implement
identity resolution, proof verification, PAT issuance, Consent decisions, or recovery authority.
Security-sensitive browser actions use the server-established fresh-session requirement.
`/settings/email` keeps candidate mailbox and proof only in mounted form state. Both initiation and
completion use the canonical typed client with no-store requests. Neither value enters a URL, browser
storage, or application-wide state.

### OAuth connection approval and management UX

The independent `oauth-connections` feature implements ADR 0033's approval slice. After established fresh sign-in, one concise Spanish screen shows the claimed
client name, only requested permissions, a narrower non-empty approval subset, compact
7/30/90/365-day duration (90 default), expiration and Conectar / Cancelar. Omitted scope defaults to
read only, with no implicit write or unrequested capability. Escalation needs a new explicit review.

The independent institution `connections` feature presents `/connections/continue` using only a
public attempt reference. The server-owned browser declaration composes into the dedicated browser
client. Review requires the same User's live cookie; preparation requires fresh authority and runs
only on an explicit click. Login returns to this fixed route with the public reference, never a
caller-supplied redirect. Query state and expiry work belong to the authentication registry.
An uncertain preparation disables repeat submission and recovers through review. The screen
truthfully shows pending authorization: institution authorization, callback credentials, Account
discovery and activation remain unavailable until the verified institution capsule is installed.

Conectar submits the exact reviewed scope subset, duration and absolute expiration through the typed
origin/CSRF-protected client. Its void command result prevents callback codes from entering Atom result
state; it immediately navigates to the server-owned registered callback. Fidy never handles or stores
access/refresh credentials. An ambiguous approval failure disables repeat approval and asks the User
to restart from the agent.

`/settings/agents` lists server-derived connection identity, unverified name, approved Spanish permissions, absolute expiration, status and up to three retained canonical activity entries. Duplicate names remain separate; pagination belongs to the router and server resources/commands belong to the authentication registry. One/all agent revocation controls are distinct from Tokens personales (PAT) and Cerrar sesión. They explain that committed work is not undone and expired/revoked agents require new approval. Successful commands invalidate the list; unavailable or malformed reads never become empty state, and uncertain commands never report success. Previously loaded data is visibly stale and controls are disabled when refresh fails.

Sensitive-operation confirmation under #988 uses a server-owned native MCP form in **Claude Code and
Codex only**, not a web feature or browser handoff. The server owns the exact effect disclosure,
intent binding and atomic single-use consumption; it trusts the authorized client's response
without independently attesting human presence, as explicitly accepted in ADR 0033. Unsupported
native interaction fails closed with no browser/chat fallback. The web continues to own fresh-session
initial OAuth connection approval and connection settings/revocation; their origin/CSRF protection
is unchanged. Browser-safe contracts derive from the server declaration seam, not a copied
OAuth/domain model. Loopback ingress/Core/D1 host evidence does not authorize production
onboarding, deployment or launch.

## 4. Static production artifact

Alchemy deploys the validated output as an assets-only Worker at `app.fidyapp.com`, with
`fidyapp.com` permanently redirected to that canonical host. There is no application Worker
entrypoint. The browser Content Security Policy permits connections only to the stable API origin and
Wompi's fixed sandbox/production tokenization origins. Card fields, Nequi numbers, and DaviPlata
CC document/product and OTP material never pass through Fidy. An OTP policy must match those
already permitted origins exactly; it does not widen CSP to arbitrary provider-supplied hosts.
Cloudflare applies
the same security headers to every SPA fallback, keeps shells and release metadata revalidating with
`no-cache`, and removes that inherited value before assigning one-year immutable caching to
content-hashed assets.

Production artifact validation rejects unhashed assets, missing shell entry assets, source maps,
server-shaped output, and known Secret material. Application build and policy checks own these
properties; `infra/cloudflare` owns Production hosting topology. There is no pull-request preview
deployment. Cross-application deployment ordering and recovery behavior remain in the root
architecture and production runbook.

## 5. Testing seams

Web tests exercise behavior through rendered application and browser boundaries rather than server
implementations. Production-policy tests validate the generated static artifact, SPA fallbacks,
security headers, cache behavior, and browser bundle boundary.

The repository's cross-application browser acceptance remains owned by root architecture. It runs
the built production web mode and real public/Core Worker ingress on separate loopback HTTPS origins,
backed by isolated Miniflare D1. Loopback operator and provider fixtures supply external approvals,
proof delivery, and Wompi responses; focused `page.route` fixtures remain for browser presentation
and failure states. DaviPlata's focused browser tests use synthetic protocol fixtures, not recorded
provider responses or live Sandbox evidence. They check exact-destination refusal, one-use bearer
rotation, action/byte/time bounds, lifetime disposal and explicit same-request submission recovery.
Successful fixture tests do not prove merchant activation, provider destinations, browser CORS or
Production readiness; those remain separate operator-evidence gates. The server contract gate owns
generated OpenAPI freshness, while browser checks prove that neither host publishes that artifact.

Browser journey sign-in fixtures advance only the browser's initial polling timer after operator
approval; real Core proof verification, rate limits, and session creation are unchanged. Dedicated
pairing journeys retain real-time cadence and real approval/redemption evidence. The mocked expiry
case advances the browser clock through a pending request and its deadline rather than sleeping.
The browser verification group also runs the native CLI journey through
`bun run test:browser:cli` in its dedicated `4183–4185` public/Core topology, with fresh D1 and
isolated native credentials. The shared suite excludes that journey: other tests must not change
its exact result comparisons or PAT Audit counts, and its loopback evidence observer exists only in
CLI acceptance mode. CI preserves separate shared/CLI per-test JSON timings without capturing
traces, screenshots, or video.

The authenticated `/insights/recurring/$id` route reads the complete frozen recurring-charge report
through `insights.getRecurringDigestReport`. Its server-owned report/path schemas cross the single
browser client publication. The feature renders every historical item as escaped React text with
exact Money/Currency formatting and captured date/zone context. Canonical loading, retry and refresh
failure states use the existing session registry and query presentation; the URL carries only the
opaque report identity and supplies no authorization.
