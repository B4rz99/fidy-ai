# Mandatory verified-email authentication and recovery

- **Status:** Accepted
- **Date:** 2026-08-23
- **Amended:** 2026-08-23
- **Active specification:** [Email authentication and recovery specification](https://github.com/B4rz99/fidy-ai/issues/14)

## Context

`UserId` must remain the stable owner when WhatsApp access changes or disappears. An optional
verified email would leave some Users with no safe independent login proof and force support either
to deny recovery or infer identity from new contact details, documents, or financial facts. Making
email mandatory adds onboarding friction and another item of personal data, but it establishes one
consistent mailbox credential before Fidy creates durable User state.

Email must not become a second identity root. Authentication that creates another User, swaps a
WhatsAppIdentity, or introduces its own session would split ownership and financial history. Naming
the credential only for recovery would also hide that the same established proof supports ordinary
email login.

## Decision

A User has exactly one VerifiedEmailCredential. New onboarding accepts the current Consent
disclosure first, collects the required email, and proves mailbox control before creating the User.
The normalized credential is globally unique; normalization trims and lowercases the address and
never applies provider-specific dot or plus-address equivalence. The onboarding disclosure covers
the mandatory contact and authentication purpose, so there is no separate email Consent grant.

Resend is the launch outbound adapter. EmailAuthentication owns bounded pre-User mailbox enrollment,
short-lived purpose-bound proofs, durable delivery state, the VerifiedEmailCredential, replacement,
and email approval of BrowserLoginPairing. Proofs are stored only as digests and submitted through
direct POST bodies on stable first-party web forms. They do not enter WhatsApp, Transcript, model
context, URLs, logs, analytics, or recoverable storage. A signed-in replacement verifies the
candidate before atomically replacing the current credential; the old credential remains
authoritative until that commit.

Ordinary email login and email-assisted recovery use the same mechanism: a valid proof for the stored
VerifiedEmailCredential approves an existing BrowserLoginPairing for that credential's existing
UserId. The browser-private verifier remains independently necessary and Browser Login alone creates
the WebSession. Authentication remains available after explicit Consent revocation so the User can
reach Fidy-owned re-consent and data-rights surfaces, while ordinary canonical work remains blocked.
Email authentication never creates a User, substitutes a newly supplied email, or replaces or
reassociates WhatsAppIdentity.

Recovery owns BackupRecoveryCode digests and SupportRecoveryCases. Onboarding discloses one
BackupRecoveryCode once and retains only its digest. If both email and WhatsApp authority are lost,
an authenticated operator CLI may use that code and a tracked metadata-only SupportRecoveryCase to
approve an existing BrowserLoginPairing. Approval consumes the code. If the User has also lost it,
Fidy refuses recovery rather than attempting document-based KYC or inferring ownership from personal
or financial facts.

## Consequences

The final onboarding transaction composes EmailAuthentication, Recovery, Identity, and Consent owner
operations under ADR 0009. Identity starts the TrialPeriod as part of creating the User; TrialPeriod
is not another owner. Credential replacement, ordinary email login, and both recovery paths preserve
stable UserId and financial history. Post-revocation authentication is a narrow exception to the
ordinary Consent gate, not permission for financial processing.

## Rejected alternatives

- **Optional email:** rejected because it leaves an unbounded unsafe support fallback.
- **Recovery-only naming:** rejected because the same credential supports ordinary login and
  recovery; the narrower name would misstate its lifecycle and purpose.
- **EmailIdentity or a generic identity-provider abstraction:** rejected because the mailbox is a
  credential for one stable User, not another identity root, and the launch choice is concrete.
- **Passwords, magic links, or proof-bearing URLs:** rejected because they add durable or leak-prone
  bearer surfaces without improving the paired-browser proof.
- **Phone fallback or automatic WhatsApp reassociation:** rejected because mutable or recycled phone
  evidence cannot prove ownership of the existing User.
- **Documents, financial history, or newly supplied contact details as support proof:** rejected
  because Fidy performs no KYC and those facts do not safely establish remote authority.
