# Explicit user context and operation-derived isolation

- **Status:** Accepted
- **Date:** 2026-08-01

## Context

A User's identity must survive phone, channel, provider, and credential changes. Every request and
background execution must operate on an explicit subject. Ambient request services and repeated owner
fields either hide the caller or make ownership part of every domain schema.

The API surface is derived from canonical operations, so isolation coverage must not depend on a
hand-maintained list that can omit a new operation.

## Decision

`UserId` is an explicit argument to every repository and core function that needs user context. The
caller is resolved at the adapter boundary and passed inward; there is no ambient `CurrentUser`
service. Ordinary aggregates do not carry a `userId` field because the User is the operation context.
`ConsentRecord` and `AuditLogEntry` carry an explicit subject because their purpose is to attest who
acted.

The Cloudflare application uses a private data boundary. The public Worker cannot access private D1;
operation-derived isolation evidence enumerates the assembled API, seeds two subjects, and verifies
that one subject's operations cannot see or mutate the other's data. Queue, Workflow, and Email Worker
paths also carry the subject explicitly. Durable Object keys coordinate work but never authorize it.

A User's current ServiceMarket, locale, and IANA time zone are explicit context. Artifacts that need
later interpretation capture the relevant context and revision at creation; current preferences
never reinterpret historical facts.

Attributable canonical calls cross an authorization boundary that records metadata-only audit entries.
Resolved operation state and its success evidence share one atomic state unit; rejection and failure
evidence survives the operation. A bearer that cannot be resolved creates no invented subject or
audit record.

## Consequences

Function signatures make caller context visible to Worker orchestration and background work. Shell code
must load one subject's data before passing values to core decisions, and reconciliation must prove
that its adapter caller loaded the same subject.

The operation-derived isolation test is maintained as a contract and adapter seam. A new canonical
operation automatically enters the reflected policy set; it cannot silently bypass the subject
boundary.

## Rejected alternatives

### Put `userId` on every aggregate

Rejected because ownership is operation context, and the field would leak into canonical schemas or
require stripping from every operation.

### Use an ambient `CurrentUser` service

Rejected because it hides the caller and is unavailable to background jobs without another path for
supplying the User.

### Use a process-local or public data store

Rejected because it cannot prove isolation across Worker requests or replicas. Private D1 and explicit
subject propagation are the authority.
