# Web architecture

This document owns the internal architecture of `@fidy/web`. Read the repository
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) first for system shape, cross-application contracts,
production topology, and browser-to-server ownership.

---

## 1. Application shape

`apps/web` is the `@fidy/web` React/Vite application package and produces a portable static artifact.
It owns product browser routing, providers and styles. Public marketing and policy copy belong to
`apps/site`, which renders the public website with Astro. Its server imports use the
browser-safe `@fidy/server/client` declaration seam and the narrow `browser-bootstrap` and dependency-free
`browser-transport` declarations; it never imports server implementations. The API
Workers do not serve web routes or static assets.

Effect Atom derives browser transport from the assembled `FidyApi` with
`AtomHttpApi.Service()("FidyClient", { api: FidyApi, httpClient: ... })`. A shared browser HTTP policy
layer bounds and sanitizes that transport beneath each generated client; the web application does not
hand-wrap endpoints or declare a second canonical surface. Each canonical API client permits two
active transfers through complete response materialization. Waiting uses the original request deadline;
interruption removes queued work, and retry pacing releases capacity. This volatile browser budget
does not replace server admission across tabs and clients. Only GET/HEAD transport failures retry
once. Canonical requests and safe web-auth reads may additionally retry a decoded `ResourceLimited` refusal with bounded
`Retry-After` pacing (six retries, delays of one to five seconds) inside the original boundary deadline (15 seconds for canonical requests, 10 seconds for ordinary web-auth reads). This proves non-admission; commercial exhaustion, uncertain mutations, authentication,
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

Needs Review publishes navigation separately from its lazy workspace through `feature.tsx`.
The route preloads both the retained workspace and its route wrapper before navigation commits,
so a second presentation suspension cannot retain the previous route's Consent reader.

Transactions and Dashboard
commit their existing query owners while their presentation modules load. Capture and calendar
code load before the Transactions workspace becomes usable rather than moving that cost to its
first interaction. Poppins uses Latin subsets with the original fonts retained for other scripts. Sidebar artwork
uses display-density variants, retaining the originals for the larger access screen.

After the application boundary latches the browser session, the initial Budgets
and Recurring routes may mount the same session-registry profile query before presentation loads.
Transactions starts ordinary reads only after its fresh Consent gate, preserving Privacy-only
access after withdrawal. Its navigation count shares the page's fresh Consent query and mounts
ordinary reads only after Granted, including on a full reload of read-only history. Consent remains owned by each page's existing zero-idle-TTL query and fresh-read gate. The
immutable initial binding only classifies unauthenticated failures and navigation display; every
protected request retains the bound header, server checks, and authentication-lifetime cancellation.

Navigation requests Review counts with a zero-row window; the Review workspace retains its
default 50-record window and the same User-scoped counts and authority checks.

Transactions requests 25 records for its initial view, then uses the existing default 100-record
continuations. The canonical query accepts an integer limit from 1 through 100, defaulting to 100;
the User-owned keyset cursor remains valid across page sizes. Display summaries still describe
only loaded records, and reaching the continuation retains access to the remaining history.

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
bounded visible conversation through popup dismissal and route navigation. `ApplicationFrame`
retains one chat provider across independently authorized product routes; each route still gates
chat visibility. Entering Privacy or ending the authentication lifetime discards that provider.
The frame subscribes to its rendered access state, not the distinction between independently
authorized and ordinary product routes. Moving between those routes keeps the shared shell stable;
the route owners still recheck Consent, and expired ordinary access still renders refusal.
An accepted processing response starts bounded observation of that exact Turn in the command's
Effect lifetime, without resubmitting its message. Progress failures or an exhausted observation
bound retain explicit recovery; unresolved execution still blocks new submissions. Disposal stops
the pending checks.
AI Elements conversation/message presentation uses Fidy primitives and the existing
Effect hosted Turn client, without introducing another AI transport. Text is escaped, not executed
as model-provided HTML. After a proposed reply renders in the open popup in a visible document,
the browser automatically acknowledges its delivery once. The ordinary conversation shows no
receipt button or completion footer. Replies received while the popup is closed or the document
is hidden remain unacknowledged until visible. Failed delivery acknowledgement retains the exact
proposal for a connection retry, and unresolved execution or delivery blocks another submission. The reply and one-use
receipt stay in mounted component state, not browser storage or a URL. This
channel is not a tool-callable canonical operation and uses the same origin-locked, no-store,
redirect-rejecting, bounded browser HTTP policy as the derived clients. The
web does not maintain copied canonical schemas, operation maps, or access policy. Host-issued recurring
lifecycle reviews may carry an opaque exact-input confirmation command alongside readable text.
Only the mounted conversation owner handles that command; presentation receives a confirmation
flag and action, never the command. A model-written challenge is ordinary escaped text and cannot
create an approval control. The command is sent only by an explicit click after visible delivery is
acknowledged, stays out of displayed history, and is never stored in a URL or browser storage. The Pro payment flow
is browser-mediated: method-specific card, Nequi and DaviPlata authorization goes directly to Wompi
and shares Price, Consent and payment status views. A separate server-declared availability GET,
owned by the session's Effect Atom registry, advertises DaviPlata only when operator activation and
reviewed exact OTP destinations allow it. Availability is not a canonical operation, a browser
activation switch, or a chatbot activation path; preparation still enforces the server's one-source
restriction. Explicit method selection can replace a cleared failed card with a wallet; it never
submits another payment automatically. Pending/verifying and successful payments keep selection
locked, while final failure permits another method with fresh terms and authorization.
Missing or failing availability does not advertise any method; the User can explicitly reread availability.
The `/upgrade` route uses the independent ApplicationShell and its shared theme/navigation owner.
Its cookie-only SubscriptionConsentBoundary still gates all ordinary subscription queries and
payment controls. The shell does not mount Hosted Agent, retained product workspaces or the canonical
pending-count query on this route, including before Consent is known or after it is withdrawn.
The Subscription workspace presents selection and authorization as separate steps. No Price is selected
on entry, and only Continue prepares the chosen enrollment. Returning to selection disposes the mounted
form; pending or successful payment and live DaviPlata authorization keep that action locked. Payment
feedback separates source availability from verified settlement, and paid access/history use canonical
SubscriptionStatus rather than invented renewal or payment-source metadata.

The mounted PaymentEnrollment interaction module owns Price and method selection admission,
preparation, submission progression, bounded visible-page observation and explicit recovery.
Presentation dispatches domain actions instead of constructing executable work or coordinating flow
identities and resets. The module fences late completions after disposal; the existing gateway keeps
provider authorization and transient credentials private. An uncertain submission blocks another
submission and selection changes. Explicit recovery checks the same enrollment and resumes an
admitted submission with its retained PaymentRequestId, then observes its BillingAttempt; source
availability alone does not complete recovery. Failed or missing continuation retains the lock.

The DaviPlata form visibly supports only cédula de ciudadanía (CC). Document/product drafts and
OTPs remain React-local and travel directly to Wompi, never in Fidy payloads, browser storage, page URLs,
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

### NeedsReviewItem decisions

Each retained Pending/History panel and page owns one registry-backed decision module. It encloses
draft-save ordering, acknowledged revisions, individual and bulk decisions, Undo and explicit
canonical reread recovery. Presentation receives status and actions; it does not coordinate queues,
flush callbacks, or recovery remounts. Item uncertainty and bulk uncertainty retain their respective
item and panel locks. Selection changes and ordinary route hiding preserve pending saves. Actual
panel disposal or authentication teardown cancels unsent work, and evidence expiry stops new work
for that item. Already-sent mutations may commit; reopening reads canonical state. The generated
client retains authorization, transport policy and telemetry ownership.

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

Provider web signup/login begins at `/login`, discoverable from the public site.
The mounted Provider Authentication feature owns its private pairing proof, one-time recovery view,
and provider popup. It uses the generated authentication client: accept the exact disclosure revision,
initiate the selected provider, poll proof-bearing status, submit completion once, save recovery, then redeem through
Browser Login. No provider token or protocol code reaches the feature. `/auth/google-return` or `/auth/microsoft-return` closes
the popup at a parameter-free URL. Only the login document uses
`same-origin-allow-popups` so the parent can observe a manually closed cross-origin popup.
The blank popup's opener is cleared before provider navigation. Pending verification with a
closed popup shows cancellation; verified status and native association confirmation take precedence.
Cancellation closes only a still-blank or same-origin provider window. An isolated external window
may remain open: the controller discards its proof and stops polling, and the view asks the User to
close that provider window. Successful/denied callbacks return to a first-party page that closes itself.
Successful authentication loads a new Transactions document to restore strict `same-origin` isolation. Logout and every application link into `/login` load a new document so the login opener policy is installed before opening a provider; an SPA route change retains the previous document’s policy and can falsely report an open provider popup as closed.
Cancellation, timeout
and uncertain completion discard private proof and explain fresh sign-in; no mutation auto-retry or
recovery redisclosure. Authentication can succeed after Consent withdrawal while ordinary work
remains gated. Personal and work/school Microsoft accounts are accepted; initial WhatsApp linking is installed under #1091.

The single `/login` route composes provider and channel/mailbox Browser Login as mutually exclusive mounted steps. Both Google and Microsoft are visible choices. Switching methods disposes private attempt state without changing the validated public continuation. Every successful method loads a new destination document to restore strict opener isolation. One shared allowlisted destination decoder preserves CLI, OAuth review, institution continuation, PAT review and Account settings; no caller-supplied redirect is accepted.

The optional channel/mailbox Browser Login begins at `/login`. The browser retains the private verifier while WhatsApp
approval, independently established mailbox authentication, or support recovery receives only its
intended public proof. Provider contact email cannot use this mailbox path. The superseded
`/auth/verify-email` signup page is removed. Public
references cannot establish a session, and pairing material does not enter URLs, unrelated browser
state, or static artifacts.

The web uses the server's canonical authentication paths and session authority. It does not implement
identity resolution, proof verification, PAT issuance, Consent decisions, or recovery authority.
Security-sensitive browser actions use the server-established fresh-session requirement.
`/settings/account` keeps candidate mailbox and proof only in mounted form state. Both initiation and
completion use the canonical typed client with no-store requests. Neither value enters a URL, browser
storage, or application-wide state.

`/settings/privacy` independently reads Processing Consent and records explicit authenticated
withdrawal through the server-declared browser client. It remains accessible without ordinary
canonical work and exposes the public rights contact without login. Its route composes the shared
ApplicationShell without the ordinary access-expiry guard or Hosted Agent, preserving the sidebar
and compact navigation after withdrawal or session expiry. The shell mounts only the navigation
for its current `md` viewport, with a scoped media-query subscription for viewport changes. The sidebar does not mount the canonical
pending-count query on Privacy, so a product refusal cannot retire a live privacy interaction.
WorkspaceHeader and WorkspaceColumns align the controls and rights-contact panel with the settings layout.
Transactions likewise evaluates its independent cookie-only Consent read before choosing read-only
access. Retiring ordinary product access does not deny this privacy path; each history page still
requires fresh server-side WebSession proof. Granted product views still pass through SignedInContent.
The authentication registry owns status and command state; uncertain withdrawal requires an explicit
status reread before another confirmed attempt. The durable receipt survives reload. Copy distinguishes withdrawal
from access to the exact saved authorization: an explicit “Consultar prueba” action reads the
same-User historical disclosure, record reference and acceptance instant through the cookie-only
privacy transport, including after withdrawal. The record is inert text and grants no new Consent.
The browser never keeps this evidence beyond its authentication registry lifetime. Copy distinguishes withdrawal
from explicit access to visible effective Transaction history. Privacy links to the existing
`/app/transactions` workspace. Its independently reachable application shell selects the ordinary
canonical view only with current granted Consent; revoked Consent mounts the same ledger, filters,
summary and viewing-only details through fresh privacy authentication, outside commercial standing.
The privacy read supplies only display preferences and public Category taxonomy alongside financial
records. No financial record id or Audit reference appears in the UI. Atom queries own each bounded
page and the loaded-history projection in the authentication registry; each continuation rechecks
proof. No create, correction, category-write, deletion or hosted-agent control mounts in this mode.
A failed continuation remains visibly incomplete and retryable; first-page/freshness failure requires
retry or renewed sign-in. The disposable built-browser fixture links the actual scoped Audit
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
truthfully shows pending authorization and exposes a bank link only after validated PAR settlement,
within the shorter bank deadline. ResourceLimited non-admission can be paced within the original
request budget; uncertain POST outcomes cannot be replayed. Real sandbox preparation requires a private, same-User profile and a bounded operator test window. Callback credentials, Account discovery and
activation remain unavailable until the verified institution capsule is installed.

Conectar submits the exact reviewed scope subset, duration and absolute expiration through the typed
origin/CSRF-protected client. Its void command result prevents callback codes from entering Atom result
state; it immediately navigates to the server-owned registered callback. Fidy never handles or stores
access/refresh credentials. An ambiguous approval failure disables repeat approval and asks the User
to restart from the agent.

`/settings/access` composes independent mounted owners for manual PAT management, one-time PAT issuance and external MCP connections. Obsolete PAT and agent settings aliases are removed. The application owns composition and disposal; each feature retains its canonical client and command authority. MCP rows show declared name, approved Spanish permissions, absolute expiration and status, while duplicate names remain separate through canonical identity. Pagination belongs to the router and server resources/commands belong to the authentication registry. Individual and aggregate revocation remain separate for PATs and MCP connections. Successful commands invalidate their own list; unavailable or malformed reads never become empty state, and uncertain commands never report success. Previously loaded data is visibly stale and controls are disabled when refresh fails. The mounted manual PAT issuance module encloses review, request identity, command outcomes and same-User draft continuation. Presentation receives display state and User actions. Issued PAT bearer disclosure remains in its private child owner and is cleared when the combined page leaves the authentication lifetime; late command completion cannot restore it.

Sensitive-operation confirmation under #1564 uses a server-owned native MCP form in supported interactive MCP clients, not a web feature or browser handoff. The server owns the exact effect disclosure,
intent binding and atomic single-use consumption; it trusts the authorized client's response
without independently attesting human presence, as explicitly accepted in ADR 0033. Unsupported
native interaction fails closed with no browser/chat fallback. The web owns live-session connection
listing and fresh-session initial OAuth connection approval and revocation; their origin/CSRF protection
is unchanged. Browser-safe contracts derive from the server declaration seam, not a copied
OAuth/domain model. Loopback ingress/Core/D1 host evidence does not authorize production
onboarding, deployment or launch.

### Document entry

The dependency-free browser transport starts the declared session-entry request before loading the
application bundle. Public rendering can start while the request is pending; slow responses retain
the existing loading feedback. On the Transactions document this carries fresh Consent, User metadata and the
first canonical page for the User's calendar month. A binding-only recheck starts after that response
and overlaps bounded decoding; a changed binding discards every private observation. Early local or
cross-tab authentication invalidation aborts pending entry work before a registry can adopt it.

Completed work is adopted synchronously during the observer commit after its authentication listeners
are installed; it does not add another Promise hop before mounting the current information. Retiring
the entry clears its completion slot. Query families retain Atoms directly so garbage collection of
temporary lookup objects cannot lose a live handoff. A pending first remote metadata read retains
that registry’s entry display until a fresh result arrives; errors retain their ordinary handling.

The first mounted observer alone can hand these observations into the existing authentication-scoped
query owners. Explicit refresh retires a handoff and reads canonical HTTP. Initial Consent bridges
only one actual entry for at most 400ms; later Transactions entries still request fresh status. The
page's period must match the current User-timezone query key. Initial offscreen ledger rows yield to
visible information. A measured commit ref fills the viewport when its initial row-height estimate
underfills it; filters and authoritative record revisions render immediately.

Collapsed Recurring transaction-source and link controls mount their read owners on first expansion
and retain them on close, so opening a blank editor performs only its needed work.

## 4. Static production artifact

Alchemy deploys the validated output as an assets-only Worker at `app.fidyapp.com`.
`fidyapp.com` serves the separate Astro site. App-host legal and feature URLs redirect to the
site, preserving immutable Consent disclosure links. The app root enters the product; its
documents are excluded from indexing. There is no application Worker
entrypoint. The browser Content Security Policy permits connections only to the stable API origin and
Wompi's fixed sandbox/production tokenization origins, plus the exact Sandbox OTP service path
`https://api-sandbox.wompi.co/v1/webhook_events/daviplata_response/sandbox`. Card fields, Nequi
numbers, and DaviPlata CC document/product and OTP material never pass through Fidy. For that
Sandbox service, the transport constructs the query from the bound authorization ID and fixed
send/confirm operation, then verifies both provider-returned URLs before OTP egress. These transient
provider query URLs are excluded from application telemetry. Configuration cannot widen CSP to
arbitrary provider hosts or paths; Production-mode DaviPlata activation and protocol evidence remain
separate gates.
Cloudflare applies
the security headers to every SPA fallback, with the login opener-policy exception
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

Controlled browser journey sign-in fixtures advance the initial polling timer after operator approval;
latency probes wait for real polling without installing Playwright Clock. Core proof verification,
rate limits, and session creation stay active. A loopback-only operator
advances the fixture clock through observed short cooldowns. Clock-sensitive admission probes run
before concurrent journeys, and recurring read, chat, and pagination journeys own separate seeded
Users. Latency probes retain native Date, timers and Performance across full-document authentication
and reload, and run without competing browser cases. Their admission regression checks native
Performance identity and real mark entries after both transitions; the unchanged latency limits
apply only after sign-in. Mocked expiry derives its deadline from the same browser clock
that the test advances. All production admission and timeout policies remain active.
The browser verification group also runs the native CLI journey through
`bun run test:browser:cli` in its dedicated `4183–4185` public/Core topology, with fresh D1 and
isolated native credentials. The shared suite excludes that journey: other tests must not change
its exact result comparisons or PAT Audit counts, and its loopback evidence observer exists only in
CLI acceptance mode. CI preserves separate shared/CLI per-test JSON timings. Dashboard Core journeys
retain failed-run traces for seven days in the repository CI artifacts while diagnosing the
Ubuntu pointer-drop failure. Other journeys capture no traces; separate screenshot and video artifacts
stay disabled.

Approved login visual review has a separate, opt-in local harness:
`bun --bun playwright test --config playwright.capture.config.ts` from `apps/web`. It writes
synthetic-fixture PNGs and unfiltered Axe reports to `/tmp/fidy-login-captures`, or to
`FIDY_LOGIN_CAPTURE_DIRECTORY` when set. Its `.capture.ts` cases are outside normal CI discovery.

The authenticated `/insights/recurring/$id` route reads the complete frozen recurring-charge report
through `insights.getRecurringDigestReport`. Its server-owned report/path schemas cross the single
browser client publication. The feature renders every historical item as escaped React text with
exact Money/Currency formatting and captured date/zone context. Canonical loading, retry and refresh
failure states use the existing session registry and query presentation; the URL carries only the
opaque report identity and supplies no authorization.

The public `handoff` search value on `/login` locates a WhatsApp-led invitation and survives provider
selection. It contains no browser proof. New invitations require the current browser Consent notice
and Google/Microsoft authentication. The private pairing status supplies a review of the selected
account and observed WhatsApp phone. “Vincular y volver a WhatsApp” opens the fixed chat separately
with an explicit account confirmation prefilled; the caller must press Send. The initiating first-party
controller remains mounted with its private proof and polls until the originating authenticated chat
confirms the exact current provider attempt. Browser clicks and forwarded references cannot approve
anything. No Estado command or manual code copying is needed. New Users save their one-time
recovery code before Browser Login redemption; existing Users redeem without new recovery. The
server's closed completion contract permits only Fidy's fixed WhatsApp chat destination, used after
redemption. The unfinished private pairing survives an explicit retry within the mounted controller;
unmount or uncertain completion discards it. Old accepted-chat handoffs retain their exact native
confirmation requirement until expiry. Neither path can replace an existing WhatsAppIdentity.
Built-browser checks use real public/Core/local D1 and controlled external provider edges; they do
not establish availability of Google, Microsoft or the installed WhatsApp application.

### CLI connection approval

`/connect/cli` owns focused PATPairing review, separate from ordinary PAT management. Its optional
`cliCode` is decoded with the server's public-code schema. A mounted runtime atom inspects the
request using the existing live WebSession, without requiring its ten-minute freshness window; navigation never approves it. The view displays the terminal code, unverified recipient
metadata, scopes and fixed lifetime before an explicit approval click. Only the CLI claims the
bearer. Browser pairing and provider login preserve this allowlisted destination/code; no arbitrary
return URL, private verifier or bearer is placed in navigation state. Without a code, the page offers
the manual fallback for another device. Authentication registry replacement owns pending work.
The signed-in `/app/budgets` workspace keys its canonical queries by User, time zone, and selected month. `budgets.getBudgetStatus` supplies historical spending and applied caps; `budgets.listBudgets` supplies existing identities when assigning a category in an earlier month. Category labels come from the canonical category query. Editing uses the same canonical create/update contracts, including a single guarded collection rename and a versioned group Currency setting; uncertain acknowledgements lock writes until an explicit refresh. The mounted Budget editing owner concentrates monthly query freshness, write validation, synchronous write admission and explicit reread recovery. Presentation receives canonical figures and editing actions; it does not assemble mutation inputs or recovery reset identities. Interaction state owns only drafts and save feedback. Exact Money totals remain separated by Currency, and the shared workspace panel becomes a sheet for editing on phones.

Category editors inherit their group Currency; only group settings or a new group expose the Currency selector. Decimal amount controls refuse non-numeric input before submission.

The Budget summary shows recorded monthly income and all effective expenses, including uncapped categories, using the canonical report’s currency-preserving cash flow. Its Summary, Income, and Expenses selectors change presentation only; income planning remains outside the expense-cap model.

### Transaction Correction

One mounted Transaction Correction module coordinates inline Category edits, individual Corrections
and atomic bulk Corrections for the canonical history resource. It owns synchronous write admission,
observed revisions, outcomes and explicit canonical reread recovery. Drafts remain with presentation;
single and atomic mutations retain their distinct server contracts. Closing an editing panel does
not release an uncertain write. Recovery rereads history and Category data, and a failed reread
preserves the write lock. The command Atom and its HTTP runtime mount on the first write or recovery
action, so viewing history does not initialize them. The privacy history remains read-only and mounts
no Correction authority.

### Recurring workspace

`features/recurring` mounts at `/app/recurring`, using authentication-scoped canonical query atoms
for the selected month, previous unresolved month, taxonomy and detected historical suggestions.
Monthly list, calendar and summaries consume one server projection. Editors and transaction
selection live in responsive sheets; drafts stay local. The mounted RecurringPlan editing module
owns revision selection, synchronous write admission, query freshness and explicit reread recovery. Month and filter changes replace presentation and
query identities without resetting pending or uncertain writes. Accepted edits invalidate active
workspace queries; an uncertain write remains blocked until an explicit workspace and taxonomy
reread succeeds. Failed recovery preserves the write lock. The browser does not
generate schedules, match Transactions, sum Money or change the meaning of historical detection.

The `/app/needs-review` feature composes the persistent ingestion inbox, browser-only original
preview, editable draft and lifecycle history. Canonical query atoms retain server ownership;
a serialized editing owner debounces revision-bound autosaves and flushes before an explicit
individual creation or skip. Bulk skip/restore use the same canonical mutation. Uncertain writes
require a canonical reread. Original text is escaped, media locators are not rendered as public
URLs, and neither originals nor drafts enter browser storage. Navigation owns pending-count
polling within the authentication registry lifetime.

Main workspace display queries retain their last result for one minute of inactivity in the
current authentication registry. Returning to Budgets, Recurring, Transactions or Dashboard
renders that result immediately. Reads younger than five seconds remain fresh on mount and
window focus; older reads revalidate, and explicit invalidation always refreshes. Retained
Recurring workspace returns coalesce refreshes inside the same five-second window using wall
time, including calendar changes. Review always revalidates on return to observe remote drafts. Review categories share
the normal category snapshot; an unvisited history panel starts only when selected. Cached profiles
and resource results do not grant authority: the server checks live Consent, caller authority and
revision guards for every write; refresh failures still gate editing. Authenticated clients share
two in-flight request permits within their session signal, including across feature clients. Queue
time counts against the original request deadline and session retirement cancels queued work.
Dashboard initialization remains exclusive to a declared uninitialized response during an
actual visit. Consent, session binding and security settings reads retain their fresh access
checks. Router intent preloading prepares destination code and declared display reads without executing writes.
Needs Review and Recurring route loaders preload the same presentation component used by their
retained workspace, so resolving destination code does not introduce another lazy suspension. Retained panels activate
only for successful route matches, after the route preparation owner has finished. Transactions and Review use blocking loader revalidation so code-only intent preloads cannot
reveal a workspace before actual entry preparation. Budget and first Recurring intent prepare
their display data, preserving immediate cached returns. Recurring intent does not mark the
retained planning workspace as visited.
Actual Transactions entries refresh the shared Consent source before revealing the destination.
Its 400 ms idle retention bridges loader-to-React subscription only; every actual entry refreshes
it, including Back and rapid re-entry. Transaction loader preloads are disabled, so an in-flight
code-only speculative result cannot satisfy the actual entry; idle code preparation remains independent.
The route stores no copy of Consent or product data. Preparation observes the authentication
registry's existing query and leaves failures there for the ordinary error view. Cached product
information can remain visible during revalidation; waiting and failed refreshes still gate decisions.
First destination reads can complete before reveal, with code-only preparation yielding until the
foreground Transaction information is ready. Pointer, keyboard focus and touch intent prepare only
the requested Budget or first Recurring resource, or first Review material, within the same two transport permits.
The browser's protected User response includes an optional bounded Category display catalog;
category views derive it from that one source and explicit category recovery refreshes its owner.
Other transports retain the independent Category read when the inline catalog is absent.

Navigation loads the small pending-count interface without downloading the Review editor on
ordinary product entry. The badge reads counts without fetching item rows. The badge and inbox
each own bounded periodic/focus refresh for their distinct projections; another signal joins
an in-flight read rather than canceling and restarting it. Draft saves invalidate the workspace and affected item only. Create, Skip,
Restore, and explicit recovery also invalidate the dedicated navigation count key; external
ingestion changes retain the shared ingestion invalidation key. Workspace
profiles share one query and resume invalidation, with results still owned by the authentication
registry. Navigation, Transactions and Upgrade reuse the boundary's latched public session identity
for display and signed-out classification. Fresh Consent reads, session-resume identity checks and
server authorization remain independent of those display snapshots.
Category and Dashboard catalog display resources likewise share their query definitions. Review
reads retain a short render-to-subscription bridge so React can commit without canceling and
restarting an admitted read; periodic/focus subscriptions still dispose with the active owner.
Draft updates invalidate the workspace revisions and affected item details, without rereading
immutable original bytes. Original display remains fenced by its evidence deadline and
authentication lifetime. Historical recurring suggestions start only when their disclosure is
opened or the User requests another suggestions page; a collapsed, unvisited disclosure does
not compete with the planning workspace for request permits.

The root application frame owns one shared shell across authenticated and independently authorized
application routes, including Transactions; each route retains its own access checks. It retains a
visited Needs Review workspace across ordinary navigation within the authentication lifetime.
Its saved route snapshot contains only the validated filter
and offset; hidden panels keep their evidence deadline timers active but suspend their own
focus and periodic refresh subscriptions. Entering Privacy disposes
the retained workspace, as does authentication replacement. The first pending page owns its bounded workspace query, and the selected original loads alongside its detail. Returning
refreshes the current Review workspace from the route preparation owner while retaining visible
content and disabling decisions until fresh. Its response includes the first item's canonical
revision-bound detail; other selections retain their own item read and targeted invalidation.
A newer saved canonical draft replaces a clean local draft; outstanding local edits remain visible
and require recovery if superseded. A completed autosave releases its draft barrier so subsequent
bulk decisions use the fresh workspace revision.

`/settings/account` composes independently mounted verified-email replacement and backup-recovery sections under one Account header. Each feature retains its own proof and disclosure lifetime. Fresh sign-in returns to the fixed Account destination without retaining email or recovery material in navigation. Removed settings aliases have no compatibility redirects.

## Review-return failure evidence

The production browser performance gate retains its untraced capture-click to visible-review
measurement and 16ms limit. Only a failed return from Transactions triggers one diagnostic
Transactions → Needs Review replay; its original failure is always restored, including when
capture fails or times out. A successful or interrupted measurement does not start diagnostics.

The replay uses the existing synthetic fixture and only navigation links. Its scoped API guard
refuses non-read requests. Authentication is outside the trace. Work has a five-second deadline;
foreign acquisition and each cleanup request have explicit interruptible one-second budgets,
with a two-second trace-flush budget. Supported browser actions receive cancellation signals.
Trace-stop compensation is registered before trace start. The failed Page is closed after capture,
so its enclosing Playwright fixture also owns late session/handle acquisition; a deadline does not
claim to cancel an uncancellable protocol command. The guard is never removed from a still-live
failed Page: it remains until Page/context teardown, including uncertain close. The Chromium trace is capped
at 1MiB and the uploaded projection at 10,000 events. Only fixed timing-event names, phases and
numeric fields survive projection: arguments, URLs, arbitrary marks and request data are dropped.
Completion metadata is schema-decoded before it can enter the report.
The existing JSON reporter carries attachments in the existing browser-timings artifact; no
workflow permissions, upload paths or retention change.

This replay is warmer and traced: it can identify scripting, style/layout or task gaps, but cannot
retrospectively explain the exact untraced failure or replace its gate result. The failed original
duration is copied into bounded failure evidence before replay; the original assertion still runs
before any attachment, so attachment failure cannot replace its failure. Original thresholds,
retry policy and application runtime remain unchanged. Sanitization,
bounded accumulation, mutation refusal, failure preservation, masked acquisition/disposal deadlines
and interruption are covered through the diagnostic helper's public seams in the web script tests.

Recurring workspace reads and writes request the compact display projection: only the latest
revision of each plan crosses the browser boundary. Storage and historical occurrence calculations
retain the complete revision ledger; default API reads still return the full document. Draft
autosave starts after 200 milliseconds of idle input and subsequent automatic writes are spaced
by at least one second; explicit Create/Skip flushes remain immediate and revision-bound.

Money presentation retains at most 32 locale/currency/precision formatter configurations. The
cache contains no amounts or User data; exact decimal parsing and rounding remain unchanged.
