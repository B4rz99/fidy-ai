# Atomic verified-onboarding bootstrap across owner seams

- **Status:** Accepted
- **Date:** 2026-08-01
- **Amended:** 2026-08-23
- **Related:** [ADR 0020 Mandatory verified-email authentication and recovery](./0020-mandatory-verified-email-authentication-and-recovery.md)

## Context

Onboarding has four inseparable owner results. Identity creates the stable User and verified
WhatsAppIdentity it owns and starts the TrialPeriod. Consent appends the immutable onboarding
ConsentRecord. EmailAuthentication installs the VerifiedEmailCredential, and Recovery installs the
BackupRecoveryCode digest. The User has accepted the disclosure before supplying the email, but the
pending decision cannot become subject-bearing evidence until the subject exists.

Moving those records into one slice would hide their independent lifecycle invariants. Consent owns
pending decisions and append-only evidence; Identity owns the stable User, channel association, and
TrialPeriod; EmailAuthentication owns mailbox verification; Recovery owns backup credentials.

## Decision

Onboarding completion is an adapter composition over one Cloudflare D1 atomic unit. Before email
verification, only bounded pre-User decision and verification state may exist. A successful mailbox
proof consumes those states, creates the User and WhatsAppIdentity, starts the TrialPeriod, appends
the onboarding ConsentRecord, installs the verified credential and recovery-code digest, and consumes
the proof as one commit. A Durable Object may serialize the admission key, but it is coordination,
not domain authority and cannot replace the D1 atomic boundary.

TrialPeriod remains part of Identity's lifecycle. The onboarding disclosure covers the mandatory
contact and authentication email purpose; there is no separate Consent grant for that credential. No
coordinating adapter writes an owner's tables outside the published owner operation.

This is the narrow bootstrap exception to the slice boundary: it applies only to initial verified
onboarding and does not permit general cross-slice table ownership.

## Rejected alternatives

- **Create the User at Consent acceptance and verify email later:** permits a stable but inaccessible
  User and makes mandatory verification aspirational.
- **Eventual consistency or compensation:** can leave one stable onboarding result without the others.
- **Move all onboarding records into one slice:** hides independent owner invariants and later
  lifecycles.
- **Add an email-specific Consent grant:** duplicates the mandatory purpose already in onboarding.
