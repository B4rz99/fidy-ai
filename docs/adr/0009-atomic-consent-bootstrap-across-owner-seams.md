# Atomic consent bootstrap across owner seams

- **Status:** Accepted
- **Date:** 2026-08-01

## Context

Onboarding acceptance has two simultaneous obligations: Identity must create the stable User and verified WhatsAppIdentity it owns, while Consent must append the immutable ConsentRecord it owns. The legal and product invariant forbids either side from surviving alone. Moving the consent ledger into Identity would hide reusable token, delivery, and revocation semantics; moving User ownership into Consent would make a legal workflow own the product identity.

## Decision

The consent gate is a shell-only process that opens one PostgreSQL transaction and invokes the existing operations of both owning slices. Identity remains the only writer of User and WhatsAppIdentity data, Consent remains the only writer of pending exchanges and ConsentRecords, and cross-slice values remain stable references. Acceptance commits those owner operations together; failure rolls all of them back. No coordinating process may write an owner’s tables directly.

This is the narrow bootstrap exception to ADR 0003’s boundary check that data requiring atomic commit ordinarily belongs to one slice. It applies only to initial User bootstrap with its legally required consent evidence; it does not permit general cross-slice invariants, shared table ownership, or the consent-authorization coordination separately decided by ADR 0008.

## Rejected alternatives

- **Eventual consistency or compensation:** rejected because it can leave a User without legal authorization or authorization for a User that does not exist.
- **Move ConsentRecord into Identity:** rejected because the ledger also owns token grants, delivery grants, and revocations.
- **Move User into Consent:** rejected because stable identity outlives and serves workflows unrelated to consent.
