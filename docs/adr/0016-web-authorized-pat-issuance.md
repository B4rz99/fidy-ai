# Web-authorized PAT issuance

- **Status:** Accepted
- **Date:** 2026-08-12

## Context

A User needs to delegate canonical operations to an agent they control. Issuing that durable authority in chat or sending a one-time redemption link through WhatsApp would make the messaging channel carry an authority-increasing decision or bearer-equivalent Secret. Web-only issuance is stricter but gives the grant a reviewable first-party surface and supports direct delivery to the intended caller.

## Decision

The durable User-owned bearer is a **PAT (Personal Access Token)**; `AgentToken` and `UserAgentToken` are retired terms. The internal one-Turn bearer is a **HostedTurnToken** and is never a PAT.

Only a freshly authenticated web session may authorize a PAT. The stable management entry is
`https://fidyapp.com/settings/pats`. The web app supports two issuance paths behind one grant policy:

- **Manual creation:** the User enters a recipient label and scopes, reviews the disclosure and 90-day inactivity policy, confirms, and receives the raw PAT once in the first-party browser response.
- **PATPairing:** a User-owned client starts a ten-minute pairing with immutable recipient and scopes, retains a high-entropy private device code, and shows a public user code. The User reviews and approves that exact request in the web app; the initiating client polls with its private code and receives the raw PAT once over its direct HTTPS connection.

The recipient label is trimmed, 1–80 characters, and display metadata rather than verified identity; duplicates are allowed and the safe PAT short id disambiguates them. A public user code identifies a request but cannot approve or claim it. A private device code, PAT bearer, and bearer-equivalent link never cross WhatsApp, Kapso, Transcript, Memory, model context, logs, analytics, URLs, or recoverable storage. Persistence retains digests. An unapproved expired pairing creates no PAT grant; an approved but unclaimed pairing expires as a revoked grant with Consent evidence.

Canonical operations declare one access-requirement algebra rather than a fake account-security
scope. Domain operations are PAT-scoped with `read`, `write`, or `dashboard`; PAT issuance is
fresh-web-session-only; safe PAT listing, activity, and revocation are web-or-hosted. Derived HTTP,
hosted-tool, MCP, CLI, and SuggestedOperation surfaces all consume that declaration.

PATs have no fixed lifetime. The inactivity deadline is exactly 90×24 hours after activation or the latest successful authenticated use. Web and chat may list safe PAT metadata, answer from at most the latest 50 retained metadata-only AuditLogEntries, and revoke one or all PATs; chat may not issue or approve them. PAT-wide revocation never affects HostedTurnTokens.

## Rejected alternatives

- **Conversational issuance or approval:** rejected because WhatsApp should not increase durable third-party authority.
- **WhatsApp URL button or magic-link delivery:** rejected because hiding a Secret from visible text does not remove it from the provider transport.
- **Web-only manual copy:** rejected as the sole path because first-party CLI and local-agent clients can receive a PAT directly without human copy/paste.
- **OAuth authorization server:** rejected for the MVP; local clients need only PATPairing, and remote MCP remains out of scope.
