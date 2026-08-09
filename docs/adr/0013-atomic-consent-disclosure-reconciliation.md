# Consent disclosure reconciliation is owned by one deep WhatsApp module

- **Status:** Accepted
- **Date:** 2026-08-09

## Context

A WhatsApp disclosure attempt is WhatsApp-owned operational state, while the pending exchange and its disclosure evidence are Consent-owned. Accepted provider evidence must advance both records atomically. Definitive rejection may schedule bounded retry, but an ambiguous outcome must never cause another send.

Kapso's authenticated lifecycle webhook is the reconciliation evidence seam. If a webhook is permanently missed, the attempt remains ambiguous indefinitely. Recipient identity, content, approximate time, and generic logs are not correctness evidence.

The earlier operator gateway spread claims, transitions, privileged state, and audit mechanics across a CLI, a role, SQL functions, repositories, and acceptance tests. It also offered no trustworthy human-only evidence source beyond what automatic reconciliation can consume.

## Decision

One deep WhatsApp disclosure-delivery module exposes three operations: request delivery, apply authenticated lifecycle evidence, and process one due retry. It owns provider attempts, claim expiry, retry scheduling, ambiguity, exact webhook correlation, and atomic coordination with the Consent owner operation. Routes, onboarding, and workers use only this interface.

Kapso remains a true external seam with production and deterministic fake adapters. PostgreSQL remains concrete behind the module; no repository port is introduced. Delivery tables are private: `fidy_runtime` has no table DML or read authority and can execute only state-checked gateways. The module generates one random attempt UUID, sends that value as the opaque callback token, and stores only its SHA-256 hash. Authenticated callback evidence is hashed before lookup.

Authenticated lifecycle bodies are authoritative. The unsigned event header must agree with the latest chronological status in the authenticated status history. `sent` is nonterminal; verified `delivered` or `read` evidence advances Consent, and only allowlisted transient failures can schedule another of at most four sends.

Manual reconciliation, `fidy_operator`, `OPERATOR_DATABASE_URL`, and the operator CLI are removed. A future human recovery path requires a separate decision naming trustworthy evidence unavailable to automation and a narrowly scoped authority.

## Consequences

The module interface is small while its implementation is deep. Callers and public-channel acceptance tests do not coordinate claims, leases, attempts, retry timestamps, or SQL transitions. The executable channel contract includes authenticated webhook reconciliation and no automatic replay after ambiguity.
