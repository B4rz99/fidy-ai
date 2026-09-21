# Atomic PAT and Consent lifecycle

- **Status:** Accepted
- **Date:** 2026-08-12

## Context

A PAT grant or revocation without matching append-only Consent evidence is an illegal authorization
state. PAT owns bearer lifecycle and Consent owns ConsentRecords, so neither owner can absorb the
other without weakening slice ownership.

## Decision

The Cloudflare Worker invokes transaction-aware operations from the PAT and Consent owners in one
User-scoped D1 atomic unit. Manual issuance and approved PAT pairing commit PAT state, fixed lifetime,
and ConsentRecord together. Revocation, revoke-all, approved-but-unclaimed expiry, and fixed-lifetime
expiry commit the PAT state and symmetric revocation evidence together. A failure commits neither and
retries append no duplicate evidence.

The Worker does not write owner tables directly and performs no browser, messaging, model, or other
provider call inside the atomic unit. Consent evidence records its honest origin. Authentication
denies an expired or revoked PAT immediately; a Queue or Workflow may later record automatic expiry
through the same owner operations. If the adapter is unavailable, issuance and revocation fail
closed.

## Rejected alternatives

- **Eventual consistency or compensation:** permits usable authority without evidence or evidence for
  authority that never existed.
- **Move PAT lifecycle into Consent:** bearer authentication and activity are not ledger
  responsibilities.
- **Move ConsentRecords into PAT:** the ledger also serves onboarding, proactivity, and data-rights
  decisions.
- **Let authentication append automatic evidence:** request authentication should deny immediately
  without owning scheduled lifecycle coordination.
