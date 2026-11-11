# Web architecture

This document owns the internal architecture of `@fidy/web`. Read the repository
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) first for system shape, cross-application contracts,
production topology, and browser-to-server ownership.

---

## 1. Application shape

`apps/web` is the `@fidy/web` React/Vite application package and produces a portable static artifact.
It owns product browser routing, providers and styles. Public marketing and policy copy belong to
`apps/site`, which renders the public website with Astro. Its server imports use the
browser-safe `@fidy/server/client` declaration seam and the narrow `browser-bootstrap`, `money`,
`dashboard-contract`, `hosted-turn-api`, `browser-http` and dependency-free `browser-transport` declarations; it never imports server implementations. The API
Workers do not serve web routes or static assets.

`transport/session-entry.ts` owns the initial session observation and its bootstrap response codecs.
`transport/session-binding.ts` owns immutable request binding, cancellation and shared transfer
coordination. Ordinary channel clients and the shared HTTP policy do not import the bootstrap API
to perform those duties. Dependency-free browser transport declarations supply header formats and
continuation paths; `@fidy/server/browser-http` supplies the original complete refusal codec only
when an eligible response could permit automatic replay. Loading that codec counts toward the
original request deadline and Retry-After wait. A missing decoder fails closed without replay.
The materializer checks native byte chunks directly and retains the same complete-transfer bounds.

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

Connection continuation mounts one private task under the validated public attempt and immutable
session binding. Its synchronous admission gate is consumed before dispatch and never reopened by a
Ready read, including after an unconfirmed POST. Reads retain the canonical continuation review;
pending or failed refreshes suppress actions. Disposal retires callbacks and interrupts local work
without claiming remote rollback. Original attempt and shorter handoff deadlines are checked at
action time as well as by authentication-registry expiry work, including auxiliary link navigation.
The same expiry projection disables refresh and removes the bank handoff.
Bank handoff remains distinct from Connection activation. Existing browser transport diagnostics
cover these calls; this local admission change adds no telemetry or browser persistence.

The hosted conversation derives its client directly from the existing `HostedTurnApi` declaration.
It shares the same browser HTTP policy, transfer budget and immutable session binding as the other
clients, without constructing the canonical API catalog when loaded independently.

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

The Transactions feature interface keeps route search and bootstrap hydration independent of its
workspace, capture and calendar implementation. Its preload overlaps the list owner and the same
presentation component used at render; Recurring likewise prepares its injected capture component
with destination code. Other entries do not need Transaction presentation to interpret a route or
hydrate their session registry.

An optional feature-owned `code.ts` entry lets application composition start code preparation
without evaluating the feature's React, transport or query declarations first. Transactions,
Dashboard, Budgets, Needs Review, Recurring, Subscription and the conversation presentation use
this entry alongside their route imports so presentation discovery does not wait for the shared runtime. It prepares code only; clients, data reads and
access checks remain with the actual route.

Production chunking keeps code-only bootstrap helpers together, shared runtime libraries together,
and each feature's closed panels together. Common read presentation stays cohesive; payment
protocol adapters and interaction-only controls do not enter that common group. Shared UI uses
ordinary static package imports rather than top-level asynchronous imports that can wait on a
chunk depending on the waiting parent. Code preparation never supplies an access decision.
Feature implementation files stay private, and session, transport and UI modules cannot import
the code-preparation entry.

The production bundle retains deliberate shared grouping to bound request waves. A smaller named
runtime alone is not evidence of improvement: compare the complete entry dependency set, request
waves and populated-content readiness before adopting a different split.

After the application boundary latches the browser session, the initial Budgets
and Recurring routes may mount the same session-registry profile query before presentation loads.
Transactions starts ordinary reads only after its fresh Consent gate, preserving Privacy-only
access after withdrawal. Its navigation count shares the page's fresh Consent query and mounts
ordinary reads only after Granted, including on a full reload of read-only history. Consent remains owned by each page's existing zero-idle-TTL query and fresh-read gate. The
immutable initial binding only classifies unauthenticated failures and navigation display; every
protected request retains the bound header, server checks, and authentication-lifetime cancellation.

Navigation requests Review counts with a zero-row window; the Review workspace retains its
default 50-record window and the same User-scoped counts and authority checks.

Review loads source context through the browser-only `ingestion.getReviewPageContext` query,
separately from the metadata workspace. The authentication registry owns its short idle retention;
page deadline subscriptions suppress expired excerpts in rows, search and accessible descriptions.
Search covers the current page's displayed draft facts, source references and unconfirmed excerpts;
visible guidance states that scope. Context query identity follows page membership; a dedicated key
refreshes it for decisions and recovery, while draft autosaves refresh metadata without rereading
source excerpts. External ingestion retains the shared ingestion invalidation key. Context read
failure retains explicit retry and metadata access. Email rows use the retained receipt timestamp
in their reference and offer an explicitly scoped search of the opened original's loaded lines,
without fetching every email body for the page.

Transactions requests 25 records for its initial view, then uses the existing default 100-record
continuations. The canonical query accepts an integer limit from 1 through 100, defaulting to 100;
the User-owned keyset cursor remains valid across page sizes. Display summaries still describe
only loaded records, and reaching the continuation retains access to the remaining history. Validated
Transactions route search owns the selected month and optional local day. Date changes within the
mounted route reuse its current Consent observation so other local filters survive; entering from
another route still refreshes Consent before revealing ordinary history. Both loader preparation
and the mounted history derive the same User-time-zone month bounds. Month changes replace query,
continuation and editing lifetimes; clearing a day retains the month. Visible scope labels and
summary counts identify the period and loaded coverage. Dashboard recent entries link to their
Transaction's local day in this route. Read-only privacy history retains its independent unbounded
query and local day filter.

Transactions keeps search, direction, Category and visited page depth in a schema-versioned
browser history entry bound to the displayed session and calendar month/time zone. Back/Forward
and same-tab reload restore that view without adding private search text to the URL; a copied URL
or fresh navigation starts a new view. Clearing filters is explicit. Restoration automatically
reads at most twenty pages, with ordinary continuation available beyond that bound. Canonical
query atoms remain the only record owners; history stores no Transaction records, credentials or
access decisions. Changed or malformed session-bound state falls back to the default view.
Successful Corrections refresh the visited depth and explain when the confirmed Transaction no
longer matches; recovery retains the visited depth and filters. Router scroll
restoration applies to Transactions only and keys positions by session and history entry.
A narrow browser adapter reapplies the Router's saved scroll once restored pages render; it
captures the entry position on mount and applies it once, leaving later interaction untouched.
Same-month navigation restores the entry’s page depth through the mounted history owner, keeping
bulk selection and canonical query owners alive. Correction refreshes retain the loaded projection and ledger until all visited pages
settle; pending or failed rereads block edits. Only the editing panel resets on a new generation.

Review history links to Transactions with a validated Transaction identity. After fresh entry
Consent, its canonical lookup resolves the current effective identity and occurrence month in the
User's time zone. The ordinary month list remains unselected with its summary; a commit ref scrolls
the retained row into view without moving keyboard focus. Location reads at most twenty pages
automatically, stops on the effective identity, and leaves further continuation or retry explicit.
Lookup failure and complete-list absence remain distinct from a located record. Original evidence
expiry does not prevent opening a retained Transaction or extend the evidence deadline.

## 2. Behavioral ownership

The web application is organized by behavioral ownership rather than route visibility. Publicly
accessible product flows such as login, pairing and onboarding remain separate features. Marketing
and legal documents belong to `apps/site`; links from the site enter these app-owned flows.

Presentation shapes derive from the canonical server declaration, the dedicated server-declared
hosted Turn browser API, or web-owned view state. The authenticated layout composes a persistent Agent chat
whose launcher stays in the application header beside the theme switch. Transaction and Dashboard
headers reserve space for both controls; the non-modal chat opens below its launcher.
There is no standalone Agent route or sidebar link. A mounted conversation module owns Turn
transitions, exact receipt retention, delivery deduplication, submission gating and bounded visible
history. Presentation receives a receipt-free display projection and actions; draft text, popup state
and the browser visibility adapter remain with presentation. The feature's mounted state keeps a draft and
bounded visible conversation through popup dismissal and route navigation. `ApplicationFrame`
retains one chat provider across independently authorized product routes; each route still gates
chat visibility. Entering Privacy or ending the authentication lifetime discards that provider.
The frame subscribes to its rendered access state, not the distinction between independently
authorized and ordinary product routes. Moving between those routes keeps the shared shell stable;
the route owners still recheck Consent, and expired ordinary access still renders refusal.
The mounted conversation owns one synchronous admission gate. Its display snapshots bind visibility,
confirmation and recovery actions to the exact Turn phase and mounted lifetime; same-tick repeats
and retained older actions cannot admit another request. The reply projection contains safe text,
display identity and bound actions, while receipts and host confirmation commands remain private.
Disposal clears the mounted snapshot and fences late command replies before registry disposal.
An accepted processing response starts bounded observation of that exact Turn in the command's
Effect lifetime, without resubmitting its message. Progress failures or an exhausted observation
bound retain explicit recovery; each explicit Check makes one immediate read without reopening
automatic observation. Unresolved execution still blocks new submissions. Disposal stops
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
Paid Users can review and cancel future renewals through the existing canonical cancellation operation.
Cancellation results distinguish the Fidy renewal fence from pending or verified provider source
annulment. The canonical SubscriptionStatus includes retained cancellation evidence so reload can
recover the paid-through date and detachment outcome. A failed or uncertain mutation blocks another
submission until an explicit status read succeeds; status refresh never replays cancellation. These
requests use the existing canonical browser transport, lifetime and diagnostic policy.

The mounted PaymentEnrollment interaction module owns Price and method selection admission,
preparation, submission progression, bounded visible-page observation and explicit recovery.
Presentation dispatches domain actions instead of constructing executable work or coordinating flow
identities and resets. The module fences late completions after disposal; the existing gateway keeps
provider authorization and transient credentials private. An uncertain submission blocks another
submission and selection changes. Explicit recovery checks the same enrollment and resumes an
admitted submission with its retained PaymentRequestId, then observes its BillingAttempt; source
availability alone does not complete recovery. Failed or missing continuation retains the lock.
The prepared Price and recurring disclosure govern checkout and its summary. Until prepared facts
are known, source-only recovery retains its admitted Price for display even if the offer catalog
changes; that display fallback grants no new submission authority. Offer read feedback
keeps the same mounted task and review drafts. Observation retains its original 65-read budget
across explicit checks and visibility changes; exhaustion remains unresolved and offers an explicit
check of the same BillingAttempt. A final observation of another attempt cannot settle this task.
Only settled eligible DaviPlata submission uncertainty grants an approved same-request retry;
busy approval does not grant another action.
Cancellation is admitted only while the mounted OTP task is idle; an in-flight provider mutation
or approved submission retains its lock. Child uncertainty exposes the parent's same-enrollment
recovery without restoring OTP authority, and expired approved retry authority cannot establish
that an uncertain payment failed.

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
Automatic draft saves retain the 200 ms debounce and one-second send spacing. A queued save
rechecks its version, item admission, pacing and original expiry after acquiring the same
item permit used by explicit decision drains; a superseded timer cannot submit a newer draft
before that draft's debounce. Explicit drains bypass pacing while preserving serialization. An unrelated panel decision or
workspace refresh does not consume another item's accepted autosave. Bulk admission freezes
selected item deadlines; both the final drain check and response publication honor those original
deadlines even after the retained draft entry has expired.
Editor observation binds change and recovery actions without retaining drafts, scheduling timers
or reading HTTP. Bound actions check the mounted generation and observed item entry; recovery
replacement and disposal retire earlier callbacks. Save acknowledgments require exactly one
matching item. Missing or incomplete acknowledgments discard unsent wanted work and retain the
displayed draft with uncertainty until an explicit successful canonical reread. Recovery shares
the item permit and rechecks expiry after waiting. The first retained item deadline survives
save acknowledgments, clean canonical replacement and recovery; expiry removes retained draft
evidence and fences late results and follow-on decisions. Only deadline metadata remains until
owner disposal so a later observation cannot revive expired work.

Decisions freeze unique bounded membership and original evidence deadlines before waiting for
shared draft permits. Every acknowledgment must match the complete requested identity set,
operation status and next revision before any detail is published. Bulk work rechecks every member
after the last flush and sends one canonical mutation; preflight failure retains the panel lock.
Skip retains a volatile one-use receipt containing the committed revisions and original deadlines.
Undo prunes receipts contradicted by current observations and restores only those exact revisions,
without flushing newer drafts. Unconfirmed outcomes are never replayed. Only a newly requested,
successful canonical observation can clear uncertainty; cached display state cannot unlock it.

### Dashboard first use

The authenticated Dashboard's Effect Atom owner explicitly reads the canonical view, initializes
only on the owner-declared `DashboardUninitialized` failure, then reads again. It exposes workflow
phase feedback without copying server state into React. Initialization and second-read failures are
presented truthfully; unavailability never triggers creation, and a load makes at most one
initialization attempt. Concurrent tabs rely on canonical initialization idempotence. Successful
edits invalidate the same Dashboard resource; queries themselves never create or repair domain state.
The mounted edit module owns serialized submission, pending placement projection and canonical
reread recovery. Uncertain or missing-Widget outcomes discard unsent edits and block new edits
until an explicit successful canonical refresh. The existing query owner starts a new load for
that private recovery attempt; only its first successful, unsuperseded invocation certifies
completion. Older in-flight reads, equal-content comparisons and timestamps confer no recovery
authority. Equal-content fresh success is valid, and later ordinary reads do not revoke a completed
attempt. Dashboard retry controls pass through the editing owner. Route departure discards unsent edits; an
already-sent mutation may have committed. Presentation owns local drafts and drag mechanics.
Budget Widget configuration keeps only the selected Widget identity and local choice in React;
the live Dashboard supplies the current Widget configuration. The dialog loads current-month
Budget statuses and the shared Category catalog through authentication-scoped query atoms only
when opened. It submits the existing `update-widget` edit through the serialized edit owner,
retaining the Widget identity, title and placement. Refreshing or failed choices cannot be saved.
Missing targets retain their Category/Currency and offer explicit selection or Budget creation.
Canonical query/mutation transport retains Work observation and auditing; this presentation flow
adds no external workflow or financial-content telemetry.
See [ADR 0032](../../docs/adr/0032-explicit-dashboard-creation-and-canonical-queries.md).

## 3. Browser authentication

The session observer retains one entry containing the lifetime and its original observation,
including receipt time. Bound and Rechecking are distinct lifecycle states sharing that entry;
checking presentation is derived from the lifecycle. Initial anonymous `none` is a valid binding.
Visible-page, persisted-pageshow and transport recheck hints coalesce while a read is pending,
without scheduling a trailing read. Same-binding resume restores the same mounted workspace
without replacing its entry or refreshing its initial hydration.

A direct-browser 401 asks the session owner to recheck its immutable binding. A still-live matching
session retains its registry and ordinary navigation; a changed or absent binding retires the old
lifetime, and a failed check blocks access. This distinguishes payment freshness refusals from
session expiry without replaying a refused action. Canonical unauthenticated responses retain their
explicit authentication-expiration policy, and every protected action keeps its server authority checks.

A mismatched or unavailable binding aborts the original lifetime and its prepared work before
expiry or reload-required presentation. Retired attachments admit no late bootstrap reply or wake
hint. Disposal cancels that attachment's work; eligible repeated handoff reads remain restricted to
the same owner, while canceled or foreign-owner work cannot become a new entry. Anonymous 401
does not request binding validation.

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

The mounted task synchronously reserves a start before opening its blank popup, and reserves
association acceptance and recovery acknowledgement before their effects. This closes repeated-action
races independently of rendered controls. Each action belongs to its exact local generation and
phase; retaining an earlier action cannot accept a later review or redeem a different attempt.
Provider and chat observation share the original pairing expiry and mounted polling cadence.
An eligible WhatsApp-handoff retry retains its original private pairing and deadline. Completion
is latched before dispatch, and late responses, recovery disclosure and redemption navigation are
fenced after cancellation, restart or disposal. A lost completion remains uncertain and requires
fresh login; preparing a popup or WhatsApp message never supplies authenticated native approval.
Provider identity, disclosure validation and atomic proof consumption remain server-owned.

The single `/login` route composes provider and channel/mailbox Browser Login as mutually exclusive mounted steps. Both Google and Microsoft are visible choices. Switching methods disposes private attempt state without changing the validated public continuation. Every successful method loads a new destination document to restore strict opener isolation. One shared allowlisted destination decoder preserves CLI, OAuth review, institution continuation, PAT review and Account settings; no caller-supplied redirect is accepted.

The optional channel/mailbox Browser Login begins at `/login`. The browser retains the private verifier while WhatsApp
approval, independently established mailbox authentication, or support recovery receives only its
intended public proof. Provider contact email cannot use this mailbox path. The superseded
`/auth/verify-email` signup page is removed. Public
references cannot establish a session, and pairing material does not enter URLs, unrelated browser
state, or static artifacts.

Every browser-pairing poll carries the private verifier and may consume an approved pairing,
including one last observed pending. A lost, malformed or timed-out redemption response therefore
ends automatic polling with explicit uncertain feedback. Only an explicit fresh attempt creates
another pairing; the old proof is discarded. The original pairing deadline bounds waits and
requests. Terminal feedback, cancellation and method switching interrupt polling and mailbox work,
discard staged proofs and fence late replies. Mailbox commands synchronously check their current
phase and deadline before dispatch. The existing bounded transport diagnostics own request outcomes;
the feature adds no proof-bearing telemetry.

The web uses the server's canonical authentication paths and session authority. It does not implement
identity resolution, proof verification, PAT issuance, Consent decisions, or recovery authority.
Security-sensitive browser actions use the server-established fresh-session requirement.
`/settings/account` keeps candidate mailbox and proof only in mounted form state. Both initiation and
completion use the canonical typed client with no-store requests. Neither value enters a URL, browser
storage, or application-wide state.
The mounted replacement owner serializes request and completion, binds every intent and reply to its
local generation, and submits the captured candidate assertion. Uniform Pending does not certify
admission or delivery. Completion uncertainty retains a private admission flag in the existing
authentication registry and one bounded, versioned session-storage marker containing only the public
session binding. Reload preserves the unresolved lock; a definitive result removes only its own marker.
Another authenticated binding can begin a new task without deleting foreign recovery metadata. Before marker
overwrite and completion, the existing declared binding read must match the owner’s binding and
current generation. An unavailable observation or marker persistence refuses the completion POST.
Route disposal and document restoration clear drafts and retire callbacks without claiming to cancel a
submitted server commit. A failed request restores its entered candidate only within the mounted
feature lifetime.

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

One mounted request-bound review task owns the selected scope subset and duration. Its shared
synchronous admission gate permits one Conectar or Cancelar decision, including opposing actions
in the same tick. Admission freezes the displayed choice; later selection callbacks cannot change it
or acquire another decision. Its mount identity and synchronous authentication/page-departure
retirement fence stale decisions, reads and navigation before delayed registry disposal; a submitted
decision may still commit. Replacing a mount cannot reactivate an earlier decision's callbacks.
Cancellation uncertainty retains its failure context while an explicit read calls the generated
review client for the same request. Cached query success never restores eligibility. Only a fresh
successful pending review supplies a new selection and requires another explicit decision; failed
reads remain unavailable without claiming that authority is absent.

Conectar submits the exact reviewed scope subset, duration and absolute expiration through the typed
origin/CSRF-protected client. Its void command result prevents callback codes from entering Atom result
state; the private navigation adapter assigns the server-owned registered callback verbatim once.
A normal assignment is only handoff, not proof of arrival or code exchange. Lost/malformed approval
results and thrown navigation remain terminal uncertainty for that mounted decision and ask the
User to restart from the agent. Callback URLs and codes never enter task state or failure text.
Fidy never handles or stores access/refresh credentials.

`/settings/access` composes independent mounted owners for manual PAT management, one-time PAT issuance and external MCP connections. Obsolete PAT and agent settings aliases are removed. The application owns composition and disposal; each feature retains its canonical client and command authority. MCP rows show declared name, approved Spanish permissions, absolute expiration and status, while duplicate names remain separate through canonical identity. Pagination belongs to the router and server resources/commands belong to the authentication registry. Individual and aggregate revocation remain separate for PATs and MCP connections. Successful commands invalidate their own list; unavailable or malformed reads never become empty state, and uncertain commands never report success. Previously loaded data is visibly stale and controls are disabled when refresh fails. The mounted manual PAT issuance module encloses review, request identity, command outcomes and same-User draft continuation. Presentation receives display state and User actions. Issued PAT bearer disclosure remains in its private child owner and is cleared when the combined page leaves the authentication lifetime; late command completion cannot restore it.

Mounted PAT management owns one synchronous single/all revocation gate and retains its exact
review independently of metadata row changes. Command receipts and current query observations stay
separate: uncertainty permits explicit metadata recovery, never mutation replay. Authentication
retirement and disposal fence actions and completions and interrupt owned command/recovery waits.

Manual PAT review captures an immutable normalized grant and one request identity. Task actions bind
to the rendered state and active mounted owner; editing, clearing or replacing the review invalidates
older actions, even when the choices later match. Confirmation synchronously admits one exact
review before canonical work starts. Review expiration remains an estimate; the server grants the
full selected lifetime from issuance and retains its independent review-age and authority guards.

Manual issuance distinguishes decoded refusal from an unknown outcome. Refused reviews require a
new review, Consent refusal leads to Privacy, and rate refusal retains its original retry deadline.
Lost, undecodable, unavailable or consumed-request responses retain the reviewed facts and request
reference without replay or bearer retrieval. Existing token listing and revocation remain available
for inspection; a metadata read cannot establish the original command's outcome. Preparing another
grant is an explicit acknowledged action that returns choices to editing and allocates a new request
only after another review. Disclosure and clipboard acknowledgements remain bound to their current
mounted owner and original reveal deadline; leaving or clearing fences later callbacks. The existing
canonical transport continues to own request timing and safe failure observations.

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

Functional browser checks select reduced motion; admission and latency projects retain native
motion and clocks. Recurring lifecycle fixtures prepare prerequisite plans through the authenticated,
revision-bound canonical API; creation journeys still exercise the visible editor. Successful
review-image export is opt-in with `BROWSER_VISUAL_EVIDENCE=true`; accessibility, layout, focus and
workflow assertions always run. Failure screenshots remain enabled in their owning hooks.

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
The signed-in `/app/budgets` workspace keys its canonical queries by User, time zone, and selected month. `budgets.getBudgetStatus` supplies historical spending and applied caps; `budgets.listBudgets` supplies existing identities when assigning a category in an earlier month. Category labels come from the canonical category query. Editing uses the same canonical create/update/delete contracts, including a single guarded collection rename and a versioned group Currency setting; uncertain acknowledgements lock writes until an explicit refresh. The mounted Budget editing owner concentrates monthly query freshness, write validation, synchronous write admission and explicit reread recovery. Presentation receives canonical figures and editing actions; it does not assemble mutation inputs or recovery reset identities. Interaction state owns only drafts and save feedback. Exact Money totals remain separated by Currency, and the shared workspace panel becomes a sheet for editing on phones.

Category editors offer confirmed permanent deletion across all months, with the selected month, historical caps, future inheritance and operational alert-mark consequences explained before submission. Transactions and recorded alert history remain intact. Accepted and uncertain deletions invalidate retained Budget and Dashboard projections. The locked mobile deletion panel provides explicit reread recovery.

Category editors inherit their group Currency; only group settings or a new group expose the Currency selector. Decimal amount controls refuse non-numeric input before submission.

The Budget summary shows recorded monthly income and all effective expenses, including uncapped categories, using the canonical report’s currency-preserving cash flow. The table identifies its group figures as capped Category spending and shows uncapped Category/Currency outflows separately. Its monthly total reconciles both scopes against that same cash flow. Spending amounts open a read-only, paginated canonical Transaction query with the report’s exact period, Category and Currency; closing the sheet disposes its mounted reader. Its Summary, Income, and Expenses selectors change presentation only; income planning remains outside the expense-cap model.

### Manual Transaction capture recovery

The capture-owned mounted task retains the draft, synchronous create admission, safe committed
Transaction and immutable uncertain attempt above month/history-generation workspace remounts
and same-User profile time-zone replacement. Admitted drafts and resumed uncertain attempts keep
their original date and time zone; an explicit clear initializes the next intent in the current zone.
The committed attachment mounts and reads its retention Atom from the current authentication registry,
so a render-time snapshot disposed before route commit cannot strand history behind empty capture
initialization. The attachment releases that mount with its task when disposed.
Parents consume derived placement observations and guarded actions; they cannot set capture status.
The public form slot receives only an owner component with public capture inputs; that component
resolves the task privately, so element props do not publish recovery or admission controls.
Confirmed save is installed before existing reads are invalidated or presentation callbacks run.
Callback defects cannot reopen create or replace a confirmed save with uncertainty. The originating
form fences presentation callbacks immediately on replacement; disposing the task also interrupts
local work without claiming that a sent create was rolled back. Refreshing history
never resubmits a capture. Recovery requires an explicit reread of the current month's
history and Categories, with fresh successful observations in the current time zone before offering resume.
The User compares the attempt with history; matching fields or an absent loaded row
cannot prove a write outcome. Resuming edits the retained draft while the original
attempt remains readable, and a separate submission creates a new Transaction.
Discard removes only browser interaction state. The draft stays in mounted memory,
never URLs, browser storage or telemetry, and disappears when Transactions access unmounts.
Explicit cancellation or confirmed completion initializes the next manual draft on the current
User-local day; recovery keeps the uncertain attempt's entered date across midnight.
Recurring capture retains its separate occurrence-owned editor and recovery contract.

### Transaction Correction

One mounted Transaction Correction module coordinates inline Category edits, individual Corrections
and atomic bulk Corrections for the canonical history resource. It owns synchronous write admission,
observed revisions and outcomes. A definite save rejection automatically rereads history and Category
data without replaying the mutation. The editor retains its draft and bulk selection through that
reread; the original draft remains bound to its captured revisions. After fresh facts change,
the User opens a new review before submitting another Correction. Failed refreshes
retain the draft and lock writes until explicit retry succeeds. Recovery rereads the previously
loaded history pages while retaining their display, so later-page editing remains mounted until the
fresh pages settle. Every admitted mutation retains its affected identities until required Category
and list loaders have completed fresh canonical reads and loaded history continuation has settled.
The Correction owner resets continuation navigation without scheduling an ordinary first-page
refresh; its strict read owns that loader invocation, so a queued display refresh cannot interrupt
recovery's new first-page read.
Identities absent from that history are then read directly, sequentially within the canonical batch
bound; decoded NotFound establishes current absence but cannot attribute a lost deletion receipt.
A failed direct lookup keeps conflicting writes locked. Successful saves and explicit uncertain-outcome verification keep their existing
workspace reset. Drafts remain with presentation; single and atomic mutations retain their distinct
server contracts. Closing an editing panel does not release an uncertain write. Automatic recovery
uses the existing canonical transport observations; no financial-content telemetry or additional
external workflow is introduced. The command Atom and its HTTP runtime mount on the first write or recovery
action, so viewing history does not initialize them. The privacy history remains read-only and mounts
no Correction authority.

Individual Correction retains Currency in the local draft alongside the amount. A Currency-only
change submits complete canonical Money at the observed revision, with no conversion or rounding.
The selected Currency drives amount validation and save admission; the shared searchable selector
is explicitly disabled while the Correction owner is locked, including its portaled menu.

### Transaction Reconciliation review

Transaction detail reads the canonical inspection of the effective Transaction and both linked
originals and their retained capture kinds in one server snapshot. Missing capture information
is explicitly unavailable; notes never stand in for SourceAttestations. The browser never infers a pair from matching Money. Privacy
history does not mount this ordinary processing query or unlink authority. Pair review retains
the exact original identities and deletion intent through its confirmation. Fresh effective facts
replace the detail display; a newer revision requires history recovery before Correction. Pending, refused and
uncertain unlink outcomes lock dismissal and selection; only an explicit successful canonical
reread permits a new review or a return to history. Failed recovery keeps the lock, and recovery
never resubmits the mutation. A new detail mount performs a fresh inspection.
Confirmed unlink retains the restored originals while offering a separate deletion confirmation
for the originally selected identity. An independent recovery retains the freshly read original
for that same separate confirmation without claiming unlink success. Explicit result dismissal
refreshes history; Dashboard, Budget and
Recurring projections are invalidated after confirmed or uncertain writes. The existing canonical
transport owns authorization, Work observations and audit accounting.

### Recurring workspace

`features/recurring` mounts at `/app/recurring`, using authentication-scoped canonical query atoms
for the selected month, previous unresolved month, taxonomy and detected historical suggestions.
Monthly list, calendar and summaries consume one server projection. Editors and transaction
selection live in responsive sheets; drafts stay local. The calendar retains the full Monday-first
month grid, including empty dates, at every container width and when no occurrences match.
Wide containers preview occurrences directly; compact days show occurrence counts and open the
same paginated day agenda, with Money, status and occurrence detail access. Month changes reset
the selected day through presentation identity. Calendar layout never generates occurrences.
The mounted RecurringPlan editing module
owns revision selection, synchronous write admission, query freshness and explicit reread recovery. Month and filter changes replace presentation and
query identities without resetting pending or uncertain writes. Accepted edits invalidate active
workspace queries; an uncertain write remains blocked until an explicit workspace and taxonomy
reread succeeds. Failed recovery preserves the write lock. The browser does not
generate schedules, match Transactions, sum Money or change the meaning of historical detection.
Pause/resume confirmation comes only from a successful canonical mutation and remains with the
mounted planning owner. The selected detail survives lifecycle writes, reading plan state from
the current document separately from the occurrence's historical plan input and fulfillment status.
Other confirmed edits close the editor once its read reaches the acknowledged document revision. Occurrence detail keeps its identity through document
refreshes so a pending Transaction capture stays open; plan drafts reset only when their canonical plan input changes.
Unknown outcomes still require the same explicit reread before another write.
The confirmation retains the affected plan identity and confirmed document revision. Until a
workspace reread reaches that revision, the lifecycle display uses the confirmed action's state;
a failed refresh cannot restore an obsolete lifecycle badge or action. Recovery still gates writes.

Creating a RecurringPlan from a Transaction copies its facts without requesting an association.
The creation draft retains the selected Transaction identity locally. After acknowledged creation,
the sheet reads the unfiltered first month through the existing canonical query and presents actual
fulfillment, any known existing association, and the separate remaining expectation. Verification
failure offers an explicit read retry without resubmitting creation. A pending first occurrence
can be corrected with a forward edit from its original date. Matching and totals remain server-owned.
Twice-monthly schedules without an occurrence in the starting month read the following month once.
Background verification retains correction drafts while gating edits. The existing canonical
transport observes these bounded reads and edits.

Recurring manual marks disclose that they change tracking only. Transaction capture reuses the
Transactions-owned form and canonical mutation, preserving the plan's Currency and direction.
Application composition supplies capture through the published feature interfaces; Recurring does
not import the Transactions implementation.
Creation and association are separate explicit actions: Recurring retains only a confirmed
Transaction, its association choices and explicit capture intent identity. The Transactions-owned
capture task retains admission and its original draft facts in the authentication registry across
occurrence and month presentation changes. Placement observations disable association choices during
Saving or Unknown; changed initial or fixed facts replace only an unadmitted draft, and selection
changes cannot remount an admitted capture. Actual capture disposal
immediately fences callbacks and interrupts local work, preserving an uncertain create lock without
claiming rollback. An explicit new capture intent is available only after the created Transaction is
observed linked. Failed or uncertain association retains that same Transaction and uses the recurring
owner's current observed document revision after explicit recovery; recovery never repeats creation.
Association replaces the selected manual mark and does not add financial spending. Drafts and safe
results remain in memory within the authentication lifetime. The existing canonical transport owns
request observations.

The `/app/needs-review` feature composes the persistent ingestion inbox, browser-only original
preview, editable draft and lifecycle history. Canonical query atoms retain server ownership;
a serialized editing owner debounces revision-bound autosaves and flushes before an explicit
individual creation or skip. Bulk skip/restore use the same canonical mutation. Uncertain writes
require a canonical reread. Original text is escaped, media locators are not rendered as public
URLs, and neither originals nor drafts enter browser storage. Navigation owns pending-count
polling within the authentication registry lifetime.

Main workspace display queries retain their last result for five minutes of inactivity in the
current authentication registry. Returning to Budgets, Recurring, Transactions or Dashboard
renders that result immediately. Reads younger than five seconds remain fresh on mount and
window focus; older reads revalidate, and explicit invalidation always refreshes. Retained
Recurring workspace returns coalesce refreshes inside the same five-second window using wall
time, including calendar changes. Review always revalidates on return to observe remote drafts. Review categories share
the normal category snapshot; an unvisited history panel starts only when selected. The actual
Review loader retains already-supplied startup metadata in its canonical owner, including an empty
inbox, without starting a profile HTTP read. Budget navigation uses a retained profile
for display preparation while its refresh remains pending. Recurring
transaction pickers retain their query across disclosure changes and revalidate on reopening once
stale. Cached profiles and resource results do not grant authority: the server checks live Consent, caller authority and
revision guards for every write; refresh failures still gate editing. Authenticated clients share
two in-flight request permits within their session signal, including across feature clients. Queue
time counts against the original request deadline and session retirement cancels queued work.
Dashboard initialization remains exclusive to a declared uninitialized response during an
actual visit. The retained Dashboard query checks the live router location before initialization,
so Budget deletion, recovery and navigation intent can read its projection without creating a
Dashboard off-route. Consent and session binding retain their fresh access checks. Access listings
retain their previous display for five minutes while rechecking both lists on every mount and
focus; pending or failed refreshes disable decisions. Manual PAT bearer disclosure and account
proofs still dispose with their mounted owners.
Router intent preloading prepares destination code only. Pointer, keyboard focus and touch intent
start no API read or original-material fetch. Destination data reads belong to the actual route
entry under its access checks and AbortSignal. Automatic Budget and Recurring loader preloads
remain disabled so a speculative code match cannot satisfy the actual visit.
A fresh entry prepares only its selected screen and the shared conversation presentation. Closed
Transaction and Budget editors, Recurring panels, Dashboard drag controls and payment fields use
separate code imports with local pending boundaries. Selected-screen preparation resolves their
component loaders as well as downloading their modules, so an immediate first interaction can use
already-prepared code without another lazy suspension. Query, command, session and draft owners
remain mounted in their existing features. Settings forms and read charts remain immediately
available. No blanket idle destination preparation or display-data queue runs after a read.
Needs Review and Recurring route loaders preload the same presentation component used by their
retained workspace, so resolving destination code does not introduce another lazy suspension. Retained panels activate
only for successful route matches after destination code and mandatory access checks complete.
Transactions and Review return their registry data-preparation promise as deferred loader work,
owned by the route's AbortSignal. A held data read therefore leaves the workspace's approved
pending/error controls available instead of blocking the entire route. Pending reads expose screen-reader status without visible skeletons or placeholder layouts. A cached Review route commits
its retained display while its loader revalidates in the background. Transactions still awaits
fresh Consent before starting its entry preparation or revealing the destination. Actual destination visits start their display reads. Code preparation does not mark a planning
workspace as visited.
The Transactions entry preparation/rendering owner selects freshness from the actual loader cause.
Only its one-use initial observation aged from zero through less than 400 ms, or a router stay in
the mounted entry, uses cached preparation. Later entries refresh the shared Consent source,
including Back and rapid re-entry; the 400 ms idle retention alone never admits an entry. The
router supplies validated search and its signal without choosing cached or fresh access. A retired
signal prevents entry preparation from consuming the initial observation or starting ordinary work.
Transaction loader preloads are disabled, so an in-flight
code-only speculative result cannot satisfy the actual entry; code preparation remains independent.
The route stores no copy of Consent or product data. Preparation observes the authentication
registry's existing query and leaves failures there for the ordinary error view. Cached product
information can remain visible during revalidation; waiting and failed refreshes still gate decisions.
First destination reads can complete before reveal. Every actual Transaction entry still performs
its fresh Consent check; destination intent supplies no data or access decision.
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

`/settings/account` composes independently mounted verified-email replacement and backup-recovery sections under one Account header. Their presentation modules accept state and action callbacks without importing the command controllers. Money presentation and Dashboard gesture declarations import their published domain contracts directly, so presentation does not initialize the complete API catalog. Each feature retains its own proof and disclosure lifetime. Recovery keeps review and one-time disclosure mounted. Its private non-secret admission marker in the existing authentication registry retains unresolved or Uncertain rotation across same-document remounts. Review and Confirm read the current marker; dispatch latches it synchronously, and only definitive live completion clears it. Authentication replacement or a new document’s fresh session observation creates a new registry. Its canonical command returns no secret into the authentication registry; only the narrow mounted presenter unwraps the redacted code. Departure or authentication replacement fences completions and wipes the owned reference. Lost or malformed rotation responses require new sign-in before another reviewed replacement, without replay or redisclosure. Clipboard cleanup retains its ten-minute lifetime independently of the disclosure; no reveal timer is added. Fresh sign-in returns to the fixed Account destination without retaining email or recovery material in navigation. Removed settings aliases have no compatibility redirects.

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

Recurring workspace reads and writes request the compact display projection: first, current local-date
and latest revisions retain dated standing without projecting future settings early. Storage and historical occurrence calculations
retain the complete revision ledger; default API reads still return the full document. Draft
autosave starts after 200 milliseconds of idle input and subsequent automatic writes are spaced
by at least one second; explicit Create/Skip flushes remain immediate and revision-bound.

Money presentation retains at most 32 locale/currency/precision formatter configurations. The
cache contains no amounts or User data; exact decimal parsing and rounding remain unchanged.

Transaction registration and individual/bulk correction interpret amount drafts with `es-CO`
separators: periods group thousands, commas separate fractional digits, and ungrouped integers
remain valid. Malformed grouping, foreign separator conventions, nonpositive values and excess
Currency precision are rejected before submission. Existing Money opens as a plain decimal-comma
draft; the shared input policy decodes through the canonical Transaction Money codec without
floating-point conversion. Saving remains the form's existing single action.

Manual Transaction registration selects from the canonical Currency catalog, defaulting to COP.
The selected Currency stays in the local capture draft; changing it preserves the amount text and
other fields and revalidates the canonical Money precision without rounding or conversion. Recurring
capture supplies a fixed Currency through application composition, so a plan cannot create a
Transaction in a different denomination. The same resolved Currency drives the input guidance,
submission admission and canonical mutation. Confirmed registration feedback formats the server's
returned Money with its explicit Currency code; existing history and summaries retain their
per-Currency projections. The existing canonical transport owns request observations; this form
change adds no external workflow or financial-content telemetry.

Manual Transaction registration and Needs Review completion explain invalid amounts beside the field
in Spanish after blur or an attempted registration. The associated live description and invalid state
update while correcting the draft; registration focuses an invalid amount without sending a mutation.
Review suggestions convert canonical decimal points to decimal commas when opened, while saved
editing drafts retain their entered text. Review confirmation uses the same positive Money and
Currency precision policy as registration. Input validation retains other fields and remains separate
from service refusal and uncertain-write recovery.

Browser trace receipt validation imports only the shared opaque TraceId schema. Server telemetry
registries, generated canonical telemetry metadata and trace export schemas stay outside the browser
graph; the bundle gate refuses those modules. The server and browser share the same TraceId codec.

Transactions selection offers “Seleccionar todas” and “Limpiar selección” beside its count. The
selection is explicit: all loaded rows matching current filters, including offscreen rows, with
individual adjustment and no twelve-record cap. Later continuation never silently adds records;
local filters retain the selection and expose hidden selected records for inspection. Select-all
adds matching rows to that selection; replacing the loaded period requires explicit discard. Group Corrections use
`transactions.updateTransactions` with each observed revision and one shared change set. The
existing correction owner retains admission, pending state and explicit uncertainty recovery;
there is no splitting into partially committed batches or automatic mutation replay.

Canonical query projection remains observational: retained Ready data, waiting and refreshFailure
are independent. Route preparation keeps its explicit cached/fresh/display/refresh-display modes
and nonrejecting completion; preparation completion does not certify a successful new read.

Strict Transaction recovery uses loader-owned request/completion identities in the authenticated
registry. A requested read forces a new loader invocation, independently of retained display content;
equal new facts qualify. Failure, supersession, runtime failure and registry retirement settle as
unsuccessful recovery. History still owns pagination/reset, and Category recovery rereads the metadata
projection and its canonical fallback before admission can resume. Ordinary route preparation and
Budget/Recurring refresh policies keep their existing contracts and retention.

RecurringPlan standing is observed at the effective plan zone's local calendar date. Future pauses,
stops and settings do not change earlier standing; Scheduled marks a future start, and endDate only
bounds generated dates. Lifecycle controls consult retained stop/open-pause facts independently of
standing. Explicit lifecycle and current-plan edit intent capture the local date when submitted;
canonical document revision checks and live authorization remain server-owned. Stopped plans remain
editable under the existing forward-edit policy, including replacement of the future revision suffix.

Needs Review retains each item’s earliest observed original deadline in private authentication-registry
atoms containing only timestamps. These bounds survive page, membership and context-query disposal.
Context projection, original selection, generated original-read admission and route preloading share
that bound and item metadata; original expiry
does not expire a separately retained review draft or resolve its decision. Deadline subscriptions
recheck wall time on focus, page show, and visibility changes, including retained hidden panels.
This logical suppression does not depend on physical source cleanup or timely execution while suspended.

A current manual Pro grant suppresses an unsubmitted checkout. An admitted or uncertain payment
retains its mounted observation and exact identity independently of that access observation.
