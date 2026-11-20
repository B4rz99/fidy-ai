# Web-authorized PAT issuance and atomic lifecycle

- **Status:** Accepted
- **Date:** 2026-08-12

## Context

A User needs to delegate canonical operations to an agent they control. Issuing that durable authority in chat or sending a one-time redemption link through WhatsApp would make the messaging channel carry an authority-increasing decision or bearer-equivalent Secret. Web-only issuance is stricter but gives the grant a reviewable first-party surface and supports direct delivery to the intended caller.

## Decision

The durable User-owned bearer is a **PAT (Personal Access Token)**. The internal hosted credential is a **Hosted Agent Session** and is never a PAT.

Only a freshly authenticated web session may authorize a PAT. The stable management entry is
`https://app.fidyapp.com/settings/access`. The web app supports two issuance paths behind one grant policy:

- **Manual creation:** the User enters a recipient label and scopes, selects a fixed 7, 30, 90, or 365-day lifetime (90 days by default), reviews that duration and the resulting absolute expiration, confirms, and receives the raw PAT once in the first-party browser response.
- **PATPairing:** a User-owned client starts a ten-minute pairing with immutable recipient and scopes, retains a high-entropy private device code, and shows a public user code. The User reviews and approves that exact request in the web app; the initiating client polls with its private code and receives the raw PAT once over its direct HTTPS connection.

The recipient label is trimmed, 1–80 characters, and display metadata rather than verified identity; duplicates are allowed and the safe PAT short id disambiguates them. A public user code identifies a request but cannot approve or claim it. A private device code, PAT bearer, and bearer-equivalent link never cross WhatsApp, Kapso, Transcript, Memory, model context, logs, analytics, URLs, or recoverable storage. Persistence retains digests. An unapproved expired pairing creates no PAT grant; an approved but unclaimed pairing expires as a revoked grant with Consent evidence.

Canonical operations declare one access-requirement algebra rather than a fake account-security
scope. Domain operations are PAT-scoped with `read`, `write`, or `dashboard`; PAT issuance is
fresh-web-session-only; safe PAT listing, activity, and revocation are web-or-hosted. Derived HTTP,
hosted-tool, MCP, CLI, and SuggestedOperation surfaces all consume that declaration.

Each PAT receives one absolute expiration at issuance from the reviewed 7, 30, 90, or 365-day lifetime. Successful authenticated use may advance `lastUsedAt`, but it never changes, renews, or revives that expiration; creating a replacement PAT is the only way to obtain a later expiration. Web and chat may list safe PAT metadata, answer from at most the latest 50 retained metadata-only AuditLogEntries, and revoke one or all PATs; chat may not issue or approve them. PAT-wide revocation never affects Hosted Agent Sessions.

## Rejected alternatives

- **Conversational issuance or approval:** rejected because WhatsApp should not increase durable third-party authority.
- **WhatsApp URL button or magic-link delivery:** rejected because hiding a Secret from visible text does not remove it from the provider transport.
- **Web-only manual copy:** rejected as the sole path because first-party CLI and local-agent clients can receive a PAT directly without human copy/paste.

OAuthConnection grants, rotation and native confirmation have a separate lifecycle.
[ADR 0033](0033-hosted-mcp-and-oauth-agent-grants.md) replaces the original remote MCP exclusion.

## Credential and pairing details

The short id names a grant. Use it for safe activity and management metadata. Resolution records
the successful use before returning the authentication facts. An active listing carries no stable
User id, terminal state, or credential material. The bearer is redacted as a value and is exposed
as raw text by the issuance JSON codec at its one authorized delivery seam.

Use rejection sampling when mapping random bytes into public pairing-code symbols so each symbol
has equal probability. A browser-generated manual request id makes a confirmed grant retry-safe.
Pre-approval polling with the correct private proof exposes bounded cadence metadata. Claim
rechecks the approval, proof and lifecycle in the committing storage guard.

A PAT retry can establish the same issuance outcome without redisclosing a consumed bearer.
Auth-sensitive refusals for malformed, foreign and expired pairing material remain generic.
Read activity advances from the live query proof. A mutation advances activity only after its
exact successful canonical Audit row in the same atomic unit. Historical ownership can support
activity attribution but never authorizes work. Anonymous pairing cleanup preserves approved
User-bound grants, and poll/backoff records cannot alter grant authority.

Use a direct SHA-256 verifier for uniformly random high-entropy bearer material. Compare
length-checked verifiers with constant work. Directory uses only the public short id to route
a native call, and the User owner decides full bearer and capability inside protected work.
A scope-free resolution supports classification only. Final assertions roll back a skipped
evidence or Audit guard before a PAT transition can commit.

## Atomic Consent lifecycle

A PAT grant or revocation without matching append-only Consent evidence is an illegal authorization
state. PAT owns bearer lifecycle and Consent owns ConsentRecords, so neither owner can absorb the
other without weakening slice ownership.

The Cloudflare Worker invokes transaction-aware operations from the PAT and Consent owners in one
UserStore transaction. Manual issuance and approved PAT pairing commit PAT state, fixed lifetime,
and ConsentRecord together. PATPairing approval fixes the absolute PAT expiry from the selected lifetime;
claim receives only the remaining lifetime and cannot reset it. An approval not claimed before the
bootstrap deadline is revoked with evidence. Revocation, revoke-all, approved-but-unclaimed expiry,
and fixed-lifetime expiry commit the PAT state and symmetric revocation evidence together. A failure commits neither and
retries append no duplicate evidence.

The Worker does not write owner tables directly and performs no browser, messaging, model, or other
provider call inside the atomic unit. Consent evidence records its honest origin. Authentication
denies an expired or revoked PAT immediately; the owner alarm can later record automatic expiry
through the same owner operations. If the adapter is unavailable, issuance and revocation fail
closed.

### Rejected alternatives

- **Eventual consistency or compensation:** permits usable authority without evidence or evidence for
  authority that never existed.
- **Move PAT lifecycle into Consent:** bearer authentication and activity are not ledger
  responsibilities.
- **Move ConsentRecords into PAT:** the ledger also serves onboarding, proactivity, and data-rights
  decisions.
- **Let authentication append automatic evidence:** request authentication should deny immediately
  without owning scheduled lifecycle coordination.
