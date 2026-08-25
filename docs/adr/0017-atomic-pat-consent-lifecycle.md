# Atomic PAT and Consent lifecycle

- **Status:** Accepted
- **Date:** 2026-08-12

## Context

A PAT grant or revocation without matching append-only Consent evidence is an illegal legal and authorization state. PAT owns bearer lifecycle and Consent owns ConsentRecords, so neither owner can absorb the other without weakening slice ownership. ADR 0009's transaction exception is explicitly limited to onboarding bootstrap and does not authorize this coordination.

## Decision

A shell-only PAT lifecycle process opens one User-scoped PostgreSQL transaction and invokes transaction-aware operations published by the PAT and Consent owners. Manual issuance and approved PATPairing commit the PAT state, reviewed fixed lifetime and absolute expiration, and grant ConsentRecord together. User revocation, revoke-all, approved-but-unclaimed expiry, and fixed-lifetime expiry commit the PAT state and symmetric revocation ConsentRecord together. A failure commits neither, and retries append no duplicate evidence.

The coordinating process never writes owner tables directly and performs no browser, messaging, model, or other provider call inside the transaction. Consent evidence records its honest origin: authenticated web decision, provider-qualified chat decision for revocation, or automatic policy. Authentication denies an expired or revoked PAT immediately without changing the fixed expiration; scheduled work subsequently records automatic expiry through the same atomic owner operations.

## Rejected alternatives

- **Eventual consistency or compensation:** rejected because it permits usable authority without evidence or evidence for authority that never existed.
- **Move PAT lifecycle into Consent:** rejected because bearer authentication and activity are not legal-ledger responsibilities.
- **Move ConsentRecords into PAT:** rejected because the ledger also serves onboarding, proactivity, and data-rights decisions.
- **Let authentication append automatic evidence:** rejected because request authentication should deny immediately without owning scheduled lifecycle coordination.
