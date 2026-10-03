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
hand-wrap endpoints or declare a second canonical surface. Shared and server state belongs to Effect
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

Browser login begins at `/auth/pair`. The browser retains the private verifier while WhatsApp
approval, email authentication, or support recovery receives only its intended public proof. Public
references cannot establish a session, and pairing material does not enter URLs, unrelated browser
state, or static artifacts.

The web uses the server's canonical authentication paths and session authority. It does not implement
identity resolution, proof verification, PAT issuance, Consent decisions, or recovery authority.
Security-sensitive browser actions use the server-established fresh-session requirement.
`/settings/email` keeps candidate mailbox and proof only in mounted form state. Both initiation and
completion use the canonical typed client with no-store requests. Neither value enters a URL, browser
storage, or application-wide state.

### Planned OAuth connection UX

ADR 0033 defines a future independent `oauth-connections` feature; #977 adds no browser route or
credential handling. After established fresh sign-in, one concise Spanish screen shows the claimed
client name, only requested permissions, a narrower non-empty approval subset, compact
7/30/90/365-day duration (90 default), expiration and Conectar / Cancelar. Omitted scope defaults to
read only, with no implicit write or unrequested capability. Escalation needs a new explicit review.

Settings distinguish individual/all OAuth connection revocation from PAT controls and browser
logout. Sensitive-operation handoff shows a server-owned exact operation/input/revision projection,
requires same-User fresh authority and origin/CSRF-protected approval, and carries no credential in
URLs, browser state or model content. A public reference conveys no permission. The server owns
single-use consumption and resume policy; unsupported host interaction fails closed. Browser-safe
contracts must derive from the server declaration seam, not a copied OAuth/domain model. The
compatibility report's synthetic approval is not evidence that this UI or authority exists.

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
CI preserves per-test JSON timings without capturing traces, screenshots, or video.
