# Web architecture

This document owns the internal architecture of `@fidy/web`. Read the repository
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) first for system shape, cross-application contracts,
production topology, and browser-to-server ownership.

---

## 1. Application shape

`apps/web` is the `@fidy/web` React/Vite application package and produces a portable static artifact.
It owns browser routing, providers, styles, and public policy copy. Its only server import is the
browser-safe `@fidy/server/client` declaration seam; it never imports server implementations. The API
process never serves web routes or static assets.

Effect Atom derives browser transport from the assembled `FidyApi` with
`AtomHttpApi.Service()("FidyClient", { api: FidyApi, httpClient: ... })`. The web application does not
wrap transport or declare a second canonical surface. Shared and server state belongs to Effect Atom,
navigation state to TanStack Router, and irreducible one-component interaction state to React.

## 2. Behavioral ownership

The web application is organized by behavioral ownership rather than route visibility. Marketing,
audience, company, and legal pages form one public website surface because they share presentation
and lifecycle. Publicly accessible flows with independent product behavior, such as login, pairing,
or onboarding, remain separate features.

Presentation shapes derive from the canonical server declaration or from web-owned view state. The
web does not maintain copied canonical schemas, operation maps, or access policy.

## 3. Browser authentication

Browser login begins at `/auth/pair`. The browser retains the private verifier while WhatsApp
approval, email authentication, or support recovery receives only its intended public proof. Public
references cannot establish a session, and pairing material does not enter URLs, unrelated browser
state, or static artifacts.

The web uses the server's canonical authentication paths and session authority. It does not implement
identity resolution, proof verification, PAT issuance, Consent decisions, or recovery authority.
Security-sensitive browser actions use the server-established fresh-session requirement.

## 4. Static production artifact

Cloudflare serves only validated static output at `fidyapp.com`; there is no Worker entrypoint. The
browser Content Security Policy permits connections only to the stable API origin. Cloudflare applies
the same security headers to every SPA fallback, keeps shells and release metadata revalidating with
`no-cache`, and removes that inherited value before assigning one-year immutable caching to
content-hashed assets.

Production artifact validation rejects unhashed assets, missing shell entry assets, source maps,
server-shaped output, and known Secret material. Application build and policy checks own these
properties; cross-application deployment ordering and rollback behavior remain in the root
architecture and production runbook.

## 5. Testing seams

Web tests exercise behavior through rendered application and browser boundaries rather than server
implementations. Production-policy tests validate the generated static artifact, SPA fallbacks,
security headers, cache behavior, and browser bundle boundary.

The repository's cross-application browser acceptance remains owned by root architecture. It runs the
production web mode against the real API on separate HTTPS origins and proves the public contract
between the independently deployed applications.
