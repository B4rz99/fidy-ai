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
is browser-mediated: the browser creates a `PaymentRequestId` and tokenizes card fields directly with
Wompi. The direct enrollment client belongs to one authentication lifetime: replacing or unmounting
that lifetime revokes and disposes the client immediately, without waiting for Atom registry cleanup.
The web submits through the server-owned payment boundary and observes only browser-safe
`BillingAttempt` state through a canonical query;
provider references are not part of web application state.

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

## 4. Static production artifact

Alchemy deploys the validated output as an assets-only Worker at `app.fidyapp.com`, with
`fidyapp.com` permanently redirected to that canonical host. There is no application Worker
entrypoint. The browser Content Security Policy permits connections only to the stable API origin. Cloudflare applies
the same security headers to every SPA fallback, keeps shells and release metadata revalidating with
`no-cache`, and removes that inherited value before assigning one-year immutable caching to
content-hashed assets.

Production artifact validation rejects unhashed assets, missing shell entry assets, source maps,
server-shaped output, and known Secret material. Application build and policy checks own these
properties; `infra/cloudflare` owns Production hosting topology. The checked-in Wrangler adapter is
restricted to static pull-request previews and has no Production route. Cross-application deployment
ordering and recovery behavior remain in the root architecture and production runbook.

## 5. Testing seams

Web tests exercise behavior through rendered application and browser boundaries rather than server
implementations. Production-policy tests validate the generated static artifact, SPA fallbacks,
security headers, cache behavior, and browser bundle boundary.

The repository's cross-application browser acceptance remains owned by root architecture. It runs
the built production web mode on loopback HTTPS with explicit HTTP fixtures for browser-level API
behavior; it does not yet prove a browser-to-real-Worker flow. Cloudflare integration gates separately
exercise the public ingress, private service binding, and local D1.
