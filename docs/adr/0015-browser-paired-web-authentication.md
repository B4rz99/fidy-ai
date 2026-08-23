# Browser-paired web authentication

- **Status:** Accepted
- **Date:** 2026-08-12
- **Amended:** 2026-08-23
- **Related:** [ADR 0020 Mandatory verified-email authentication and recovery](./0020-mandatory-verified-email-authentication-and-recovery.md)

## Context

A login link sent through WhatsApp or email is a bearer-equivalent Secret until redemption. Hiding
it behind a provider button keeps it out of visible Transcript text but still exposes it to provider
telemetry, previews, and scanners. The product has three ways to prove an existing User at launch:
their WhatsAppIdentity, their VerifiedEmailCredential, or a tracked SupportRecoveryCase backed by
their pre-issued BackupRecoveryCode. None should become a parallel web-session mechanism or
transport the browser's complete proof.

## Decision

Web login is browser-initiated pairing at the stable web entry `https://fidyapp.com/auth/pair`, not a
provider-delivered magic link. This supersedes only ADR 0002's former `/auth/magic` entry. The browser
obtains and retains a high-entropy private verifier and displays a short-lived public user code. A
User may approve the pairing through their verified WhatsApp association, prove their
VerifiedEmailCredential through a direct first-party form for ordinary login or recovery, or give
support the public pairing reference plus the pre-issued BackupRecoveryCode. The private verifier
never leaves the browser, and no public reference or second-channel proof can establish a session by
itself. Pairing expires after ten minutes, succeeds once, and puts no private verifier, session
bearer, or authentication proof in chat, Transcript, model context, URLs, provider payloads, logs,
analytics, or recoverable storage.

The browser-login shell owns the unbound challenge and its lifecycle. Anonymous start admission and
insertion are one database transaction. Each approval authority invokes Browser Login's published
approval operation:

- WhatsApp approval is a canonical mutation whose caller input is only the public code; resolved
  WhatsAppIdentity supplies the stable UserId and exact hosted confirmation is required.
- Email authentication verifies a short-lived purpose-bound proof for the existing
  VerifiedEmailCredential and the live pairing private verifier before approval.
- Support recovery verifies the digest-only BackupRecoveryCode through an authenticated operator CLI
  and records a tracked append-only decision before approval.

Approval binds the existing stable UserId, supersedes that User's older ready pairing, and cannot
create a User, replace VerifiedEmailCredential, or modify WhatsAppIdentity. The browser polls with
its private verifier, and Browser Login remains the only module that creates the WebSession. A User
whose onboarding Consent is explicitly revoked may still authenticate to reach Fidy-owned
re-consent and data-rights surfaces; ordinary canonical work remains blocked until re-consent.

A fresh browser pairing is sufficient for security-sensitive web actions, including PAT issuance and
credential replacement. The MVP does not require a passkey. This accepts control of one previously
established User proof together with the independent browser verifier under the launch threat model;
surviving a total Kapso, Meta, or Resend compromise remains out of scope.

## Rejected alternatives

- **WhatsApp or email magic link:** rejected because the provider would transport a
  bearer-equivalent Secret.
- **Public code, email proof, or backup code as the complete browser proof:** rejected because an
  observer could establish a session without the initiating browser.
- **Email-specific or recovery-specific WebSession:** rejected because either would duplicate
  session issuance, revocation, and freshness semantics.
- **A newly supplied email or phone during recovery:** rejected because it proves no relationship to
  the existing User.
- **Mandatory passkey:** deferred because it adds another enrollment and recovery lifecycle beyond
  the MVP threat model.
