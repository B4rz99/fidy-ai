# Mandatory verified-email recovery

- **Status:** Accepted
- **Date:** 2026-08-23
- **Active specification:** [Recovery specification](https://github.com/B4rz99/fidy-ai/issues/14)

## Context

`UserId` must remain the stable owner when WhatsApp access changes or disappears. An optional
recovery email would leave some Users with no safe remote proof and force support either to deny
recovery or infer identity from new contact details, documents, or financial facts. Making email
mandatory adds onboarding friction and another item of personal data, but it establishes one
consistent recovery capability before Fidy creates durable User state.

Email must not become a second identity root. Recovery that creates another User, swaps a
WhatsAppIdentity, or introduces its own session would split ownership and financial history.

## Decision

A User has exactly one verified RecoveryEmailCredential. New onboarding accepts the current Consent
disclosure first, collects the required email, and proves mailbox control before creating the User.
The normalized credential is globally unique; normalization trims and lowercases the address and
never applies provider-specific dot or plus-address equivalence. The onboarding disclosure covers
the mandatory contact and authentication purpose, so there is no separate email Consent grant.

Resend is the launch outbound adapter. It delivers short-lived purpose-bound proofs that are stored
only as digests and submitted through direct POST bodies on stable first-party web forms. Proofs do
not enter WhatsApp, Transcript, model context, URLs, logs, analytics, or recoverable storage. A
signed-in replacement verifies the candidate before atomically replacing the current credential;
the old credential remains authoritative until that commit.

Email recovery approves an existing BrowserLoginPairing for the credential's existing UserId. The
browser-private verifier remains independently necessary and Browser Login alone creates the
WebSession. Recovery remains available after explicit Consent revocation so the User can reach
Fidy-owned re-consent and data-rights surfaces, while ordinary canonical work remains blocked.
Recovery never creates a User, substitutes a newly supplied email, or replaces or reassociates
WhatsAppIdentity.

Onboarding also discloses one BackupRecoveryCode once and retains only its digest. If both email and
WhatsApp authority are lost, an authenticated operator CLI may use that code and a tracked
metadata-only SupportRecoveryCase to approve an existing BrowserLoginPairing. Approval consumes the
code. If the User has also lost it, Fidy refuses recovery rather than attempting document-based KYC
or inferring ownership from personal or financial facts.

## Consequences

Recovery owns email verification attempts, the single verified credential, BackupRecoveryCode
digests, Resend delivery state, and SupportRecoveryCases. The final onboarding transaction composes
Recovery, Identity, and Consent owner operations under ADR 0009. Email replacement and both recovery
paths preserve stable UserId and financial history. Recovery authentication is a narrow exception to
the ordinary post-revocation Consent gate, not permission for financial processing.

## Rejected alternatives

- **Optional email:** rejected because it leaves an unbounded unsafe support fallback.
- **EmailIdentity or a generic identity-provider abstraction:** rejected because recovery is a
  credential for one stable User, not another identity root, and the launch choice is concrete.
- **Passwords, magic links, or proof-bearing URLs:** rejected because they add durable or leak-prone
  bearer surfaces without improving the paired-browser proof.
- **Phone fallback or automatic WhatsApp reassociation:** rejected because mutable or recycled phone
  evidence cannot prove ownership of the existing User.
- **Documents, financial history, or newly supplied contact details as support proof:** rejected
  because Fidy performs no KYC and those facts do not safely establish remote authority.
