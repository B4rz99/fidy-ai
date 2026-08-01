# Explicit user context and operation-derived isolation

- **Status:** Accepted
- **Date:** 2026-08-01

## Context

A User's identity must survive phone, channel, provider, and credential changes. Every request and
background process must also operate on an explicit user context. Ambient request services and
repeated owner fields either hide the caller or make ownership part of every domain schema.

The API surface is derived from canonical operations, so isolation coverage must not depend on a
hand-maintained list that can omit a new operation.

## Decision

`UserId` is an explicit argument to every repository function and every core function that needs
user context. The caller is resolved at the adapter boundary and passed inward; there is no
ambient `CurrentUser` service. Ordinary aggregates do not carry a `userId` field because the user
is the operation context. `ConsentRecord` and `AuditLogEntry` carry an explicit subject because
their purpose is to attest who acted.

The launch application does not use row-level security. Isolation is guarded by an
operation-derived test that enumerates the assembled `HttpApi`, seeds two users, and verifies that
one user's operations cannot see or mutate the other's data. Background jobs and ingestion paths
also pass the user explicitly.

A User's current ServiceMarket, locale, and IANA time zone are explicit context. Artifacts that
need later interpretation capture the relevant context and revision at creation; current User
preferences never reinterpret historical facts. The Colombia-first persistence choices are
specified in [ADR-0001](./0001-colombia-first-global-ready-foundations.md).

Attributable canonical calls cross an authorization boundary that records metadata-only audit
entries. Resolved operation state and its success evidence share a database transaction; rejection
and failure evidence survives the operation transaction. A bearer that cannot be resolved creates
no invented subject or audit record.

## Consequences

Function signatures make caller context visible to shell orchestration and background work. Shell
code must load the data for a user before passing plain values to core decisions, and reconciliation
trusts that its shell caller loaded one user's records.

The operation-derived isolation test must be maintained as a real API-seam test, but a new
canonical operation automatically enters its scope. Row-level security remains a possible future
reinforcement if a non-request write path begins reading user data.

## Rejected alternatives

### Put `userId` on every aggregate

Rejected because ownership is operation context, and the field would leak into canonical schemas
or require repeated stripping from every operation.

### Use an ambient `CurrentUser` service

Rejected because it hides the caller and is unavailable to background jobs without another path
for supplying the user.

### Enable row-level security now

Deferred because the application currently has an explicit ownership boundary and RLS would also
require an operational database-role policy. The revisit condition is recorded above.
