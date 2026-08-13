# Browser-paired web authentication

- **Status:** Accepted
- **Date:** 2026-08-12

## Context

A login link sent through WhatsApp is a bearer-equivalent Secret until redemption. Hiding it behind a Kapso button keeps it out of visible Transcript text but still exposes it to the messaging transport, provider telemetry, previews, and scanners. The product already accepts control of a WhatsAppIdentity as its launch authentication authority, but the provider does not need to transport a redeemable web credential.

## Decision

Web login is browser-initiated pairing at the stable web entry `https://fidyapp.com/auth/pair`, not
a WhatsApp-delivered magic link. This supersedes only ADR 0002's former `/auth/magic` entry. The browser obtains and retains a high-entropy private verifier from Fidy and displays a short-lived public user code. The User sends or confirms only that public code through the hosted agent; the code cannot establish a session by itself. The browser polls with its private verifier and receives the stable-User session after WhatsAppIdentity approval. Pairing expires after ten minutes, succeeds once, and puts no private verifier or session bearer in chat, Transcript, model context, URLs, provider payloads, logs, or recoverable storage. A security-sensitive web action accepts the session as fresh only during the ten minutes after pairing completes; afterward the User must pair again.

The MVP does not require a passkey. A fresh browser pairing is sufficient for security-sensitive web actions, including PAT issuance. This deliberately accepts WhatsAppIdentity control as the root authentication authority; surviving a compromised WhatsApp account or total Kapso/Meta compromise remains outside the launch threat model.

## Rejected alternatives

- **WhatsApp magic link:** rejected because the messaging provider would transport a bearer-equivalent Secret.
- **Public code as the complete proof:** rejected because observing or guessing the code would establish a session.
- **Mandatory passkey:** deferred because it adds a second identity, enrollment, and recovery lifecycle beyond the MVP threat model.
