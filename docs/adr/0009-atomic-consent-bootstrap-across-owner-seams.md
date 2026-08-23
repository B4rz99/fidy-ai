# Atomic verified-onboarding bootstrap across owner seams

- **Status:** Accepted
- **Date:** 2026-08-01
- **Amended:** 2026-08-23
- **Related:** [ADR 0020 Mandatory verified-email recovery](./0020-mandatory-verified-email-account-recovery.md)

## Context

Onboarding now has three inseparable results. Identity must create the stable User and verified
WhatsAppIdentity it owns, Consent must append the immutable onboarding ConsentRecord it owns, and
Recovery must install the verified RecoveryEmailCredential and BackupRecoveryCode digest it owns.
The User has already accepted the disclosure before supplying the email, but that pending decision
cannot become a subject-bearing ConsentRecord until the subject exists. Letting any stable result
survive alone would create either an unrecoverable User, consent evidence without its subject, or a
recovery credential detached from a User.

Moving those records into one slice would hide their independent lifecycle invariants. Consent owns
pending decisions and append-only evidence; Identity owns stable User and channel association;
Recovery owns mailbox verification, recovery credentials, and support recovery.

## Decision

The onboarding completion process is shell-only. Before email verification, Consent and Recovery may
retain only bounded pre-User decision and verification state linked by stable references; Identity
has no User or WhatsAppIdentity. A successful mailbox proof opens one PostgreSQL transaction and
invokes owner-published operations from all three slices. That transaction consumes the pending
states, creates the User and WhatsAppIdentity, appends the onboarding ConsentRecord, installs the one
verified RecoveryEmailCredential and BackupRecoveryCode digest, and starts the TrialPeriod. Failure
rolls back every result.

The accepted onboarding disclosure covers the mandatory contact and authentication email purpose;
there is no separate Consent grant for the recovery credential. No coordinating process writes an
owner's tables directly.

This remains the narrow bootstrap exception to ADR 0003's boundary check that data requiring atomic
commit ordinarily belongs to one slice. It applies only to initial verified onboarding and does not
permit general cross-slice invariants, shared table ownership, or the consent-authorization
coordination separately decided by ADR 0008.

## Rejected alternatives

- **Create the User at Consent acceptance and verify email later:** rejected because it permits a
  stable but unrecoverable User and makes mandatory verification only aspirational.
- **Eventual consistency or compensation:** rejected because it can leave one stable onboarding
  result without the others.
- **Move all onboarding records into one slice:** rejected because User, Consent, and Recovery each
  have independent owner invariants and later lifecycles.
- **Add an email-specific Consent grant:** rejected because the current onboarding disclosure already
  states the mandatory contact and authentication purpose; duplicate evidence would imply an option
  that onboarding does not offer.
