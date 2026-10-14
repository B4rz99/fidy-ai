# Web architecture

This document owns the internal architecture of `@fidy/web`. Read the repository
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) first for system shape, cross-application contracts,
production topology, and browser-to-server ownership.

---

## 1. Application shape

`apps/web` is the `@fidy/web` React/Vite application package and produces a portable static artifact.
It owns product browser routing, providers and styles. Public marketing and policy copy belong to
`apps/site`, which renders the public website with Astro. Its only server import is the
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

The browser emits one closed DevTools transport record per logical request: boundary, coarse outcome,
status class, bounded attempt count and duration, a fixed failure category and, when available, the
server-issued `Fidy-Trace-Id` receipt. Safe retries share that observation; interruption and deadline
exhaustion remain distinct. Receipt validation precedes export and survives body-limit refusal.
Automatic URL/header spans and client trace propagation remain disabled. Generated response decoding,
React root error callbacks and global runtime failures emit fixed defect categories with a twenty-record
document-lifetime cap. Export is best effort and cannot change application outcomes. No request, response,
schema input, error text, stack, navigation location or User state enters these records.

These records are local DevTools diagnostics, not centrally collected browser telemetry. Server traces
can correlate a transport receipt, but runtime/render failures and schema decoding failures do not carry
server receipt correlation. Navigation and component interactions are not recorded, and there is no
session recording or automatic reproduction of User content.

## 2. Behavioral ownership

The web application is organized by behavioral ownership rather than route visibility. Publicly
accessible product flows such as login, pairing and onboarding remain separate features. Marketing
and legal documents belong to `apps/site`; links from the site enter these app-owned flows.

Presentation shapes derive from the canonical server declaration, the dedicated server-declared
hosted Turn browser API, or web-owned view state. The authenticated layout composes a persistent floating Agent chat;
there is no standalone Agent route or sidebar link. A mounted conversation module owns Turn
transitions, exact receipt retention, delivery deduplication, submission gating and bounded visible
history. Presentation receives a receipt-free display projection and actions; draft text, popup state
and the browser visibility adapter remain with presentation. The feature's mounted state keeps a draft and
bounded visible conversation through popup dismissal and route navigation, and expires with the
signed-in layout. AI Elements conversation/message presentation uses Fidy primitives and the existing
Effect hosted Turn client, without introducing another AI transport. Text is escaped, not executed
as model-provided HTML. After a proposed reply renders in the open popup in a visible document,
the browser automatically acknowledges its delivery once. The ordinary conversation shows no
receipt button or completion footer. Replies received while the popup is closed or the document
is hidden remain unacknowledged until visible. Failed delivery acknowledgement retains the exact
proposal for a connection retry, and unresolved execution or delivery blocks another submission. The reply and one-use
receipt stay in mounted component state, not browser storage or a URL. This
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
The mounted edit module owns serialized submission, pending placement projection and canonical
reread recovery. Uncertain or missing-Widget outcomes discard unsent edits and block new edits
until an explicit successful canonical refresh. Route departure discards unsent edits; an
already-sent mutation may have committed. Presentation owns local drafts and drag mechanics.
See [ADR 0032](../../docs/adr/0032-explicit-dashboard-creation-and-canonical-queries.md).

## 3. Browser authentication

Provider web signup/login begins at `/auth/google` or `/auth/microsoft`, discoverable from the public site.
The mounted Provider Authentication feature owns its private pairing proof, one-time recovery view,
and provider popup. It uses the generated authentication client: accept the exact disclosure revision,
initiate the selected provider, poll proof-bearing status, submit completion once, save recovery, then redeem through
Browser Login. No provider token or protocol code reaches the feature. `/auth/google-return` or `/auth/microsoft-return` closes
the popup at a parameter-free URL. Only the two provider entry documents use
`same-origin-allow-popups` so the parent can observe a manually closed cross-origin popup.
The blank popup's opener is cleared before provider navigation. Pending verification with a
closed popup shows cancellation; verified status and native association confirmation take precedence.
Successful authentication loads a new Transactions document to restore strict `same-origin` isolation.
Cancellation, timeout
and uncertain completion discard private proof and explain fresh sign-in; no mutation auto-retry or
recovery redisclosure. Authentication can succeed after Consent withdrawal while ordinary work
remains gated. Personal and work/school Microsoft accounts are accepted; initial WhatsApp linking is installed under #1091.

The optional channel/mailbox Browser Login begins at `/auth/pair`. The browser retains the private verifier while WhatsApp
approval, independently established mailbox authentication, or support recovery receives only its
intended public proof. Provider contact email cannot use this mailbox path. The superseded
`/auth/verify-email` signup page is removed. Public
references cannot establish a session, and pairing material does not enter URLs, unrelated browser
state, or static artifacts.

The web uses the server's canonical authentication paths and session authority. It does not implement
identity resolution, proof verification, PAT issuance, Consent decisions, or recovery authority.
Security-sensitive browser actions use the server-established fresh-session requirement.
`/settings/email` keeps candidate mailbox and proof only in mounted form state. Both initiation and
completion use the canonical typed client with no-store requests. Neither value enters a URL, browser
storage, or application-wide state.

`/settings/privacy` independently reads Processing Consent and records explicit authenticated
withdrawal through the server-declared browser client. It remains accessible without ordinary
canonical work and exposes the public rights contact without login. Its route composes the shared
ApplicationShell without the ordinary access-expiry guard or Hosted Agent, preserving the sidebar
and compact navigation after withdrawal or session expiry. WorkspaceHeader and WorkspaceColumns
align the controls and rights-contact panel with the existing settings layout. The authentication registry
owns status and command state; uncertain withdrawal requires an explicit status reread before
another confirmed attempt. The durable receipt survives reload. Copy distinguishes withdrawal
from access to the exact saved authorization: an explicit “Consultar prueba” action reads the
same-User historical disclosure, record reference and acceptance instant through the cookie-only
privacy transport, including after withdrawal. The record is inert text and grants no new Consent.
The browser never keeps this evidence beyond its authentication registry lifetime. Copy distinguishes withdrawal
from explicit access to visible effective Transaction history. The “Consultar mis transacciones” action
uses the server-declared privacy transport after fresh browser authentication, independent of Consent
or commercial standing. One mounted, bounded page renders exact Money and inert Transaction text;
continuation rechecks proof rather than granting access through its cursor. A failed page is unavailable,
never complete or empty history. The disposable built-browser fixture links the actual scoped Audit
reference and visible result to the native case-register CLI; it does not import register implementation
into the web application or establish live non-User or representative entitlement.
Copy distinguishes withdrawal
from erasure, Subscription cancellation and individual access revocation, and discloses that an
already-admitted request may finish. See [scope and remaining review](../../docs/operations/processing-withdrawal-1273.md).

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

`/settings/access` composes independent mounted owners for manual PAT management, one-time PAT issuance and external MCP connections. The previous settings URLs resolve to this combined route. The application owns composition and disposal; each feature retains its canonical client and command authority. MCP rows show declared name, approved Spanish permissions, absolute expiration and status, while duplicate names remain separate through canonical identity. Pagination belongs to the router and server resources/commands belong to the authentication registry. Individual and aggregate revocation remain separate for PATs and MCP connections. Successful commands invalidate their own list; unavailable or malformed reads never become empty state, and uncertain commands never report success. Previously loaded data is visibly stale and controls are disabled when refresh fails. The mounted manual PAT issuance module encloses review, request identity, command outcomes and same-User draft continuation. Presentation receives display state and User actions. Issued PAT bearer disclosure remains in its private child owner and is cleared when the combined page leaves the authentication lifetime; late command completion cannot restore it.

Sensitive-operation confirmation under #988 uses a server-owned native MCP form in **Claude Code and
Codex only**, not a web feature or browser handoff. The server owns the exact effect disclosure,
intent binding and atomic single-use consumption; it trusts the authorized client's response
without independently attesting human presence, as explicitly accepted in ADR 0033. Unsupported
native interaction fails closed with no browser/chat fallback. The web owns live-session connection
listing and fresh-session initial OAuth connection approval and revocation; their origin/CSRF protection
is unchanged. Browser-safe contracts derive from the server declaration seam, not a copied
OAuth/domain model. Loopback ingress/Core/D1 host evidence does not authorize production
onboarding, deployment or launch.

## 4. Static production artifact

Alchemy deploys the validated output as an assets-only Worker at `app.fidyapp.com`.
`fidyapp.com` serves the separate Astro site. App-host legal and feature URLs redirect to the
site, preserving immutable Consent disclosure links. The app root enters the product; its
documents are excluded from indexing. There is no application Worker
entrypoint. The browser Content Security Policy permits connections only to the stable API origin and
Wompi's fixed sandbox/production tokenization origins. Card fields, Nequi numbers, and DaviPlata
CC document/product and OTP material never pass through Fidy. An OTP policy must match those
already permitted origins exactly; it does not widen CSP to arbitrary provider-supplied hosts.
Cloudflare applies
the security headers to every SPA fallback, with the two provider-entry opener-policy exceptions
described above, keeps shells and release metadata revalidating with
`no-cache`, and removes that inherited value before assigning one-year immutable caching to
content-hashed assets.

Production artifact validation rejects unhashed assets, missing shell entry assets, source maps,
server-shaped output, and known Secret material. Application build and policy checks own these
properties; `infra/cloudflare` owns Production hosting topology. There is no pull-request preview
deployment. Cross-application deployment ordering and recovery behavior remain in the root
architecture and production runbook.

## 5. Testing seams

Vitest tests exercise pure decisions and Effect programs through their public interfaces. UI workflows
are exercised through Playwright browser acceptance. Istanbul reports logic coverage and enforces a
90% gate at the browser transport boundary. Production-policy tests validate the generated static artifact, SPA fallbacks,
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

The public `handoff` search value on `/auth/google` and `/auth/microsoft` identifies one WhatsApp-led
attempt and survives provider selection. It contains no browser proof. The feature uses accepted chat
Consent, authenticates the selected provider, then polls with its private pairing verifier. Awaiting
confirmation shows a public association identifier and directs the caller to compare the native chat
review and reply to that exact message. New Users save recovery before Browser Login redemption;
existing Users proceed directly through the same redemption. Initial linking never exposes new recovery.
The built static browser checks cover both paths against real public/Core/D1 with external-edge fixtures.

### CLI connection approval

`/connect/cli` owns focused PATPairing review, separate from ordinary PAT management. Its optional
`cliCode` is decoded with the server's public-code schema. A mounted runtime atom inspects the
request using the existing live WebSession, without requiring its ten-minute freshness window; navigation never approves it. The view displays the terminal code, unverified recipient
metadata, scopes and fixed lifetime before an explicit approval click. Only the CLI claims the
bearer. Browser pairing and provider login preserve this allowlisted destination/code; no arbitrary
return URL, private verifier or bearer is placed in navigation state. Without a code, the page offers
the manual fallback for another device. Authentication registry replacement owns pending work.
The signed-in `/app/budgets` workspace keys its canonical queries by User, time zone, and selected month. `budgets.getBudgetStatus` supplies historical spending and applied caps; `budgets.listBudgets` supplies existing identities when assigning a category in an earlier month. Category labels come from the canonical category query. Editing uses the same canonical create/update contracts, including a single guarded collection rename and a versioned group Currency setting; uncertain acknowledgements lock writes until an explicit refresh. Interaction state owns only drafts and save feedback. Exact Money totals remain separated by Currency, and the shared workspace panel becomes a sheet for editing on phones.

Category editors inherit their group Currency; only group settings or a new group expose the Currency selector. Decimal amount controls refuse non-numeric input before submission.

The Budget summary shows recorded monthly income and all effective expenses, including uncapped categories, using the canonical report’s currency-preserving cash flow. Its Summary, Income, and Expenses selectors change presentation only; income planning remains outside the expense-cap model.
