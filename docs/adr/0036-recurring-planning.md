# Recurring planning alongside historical detection

- **Status:** Accepted for implementation from the User-approved local recurring-view specification
- **Date:** 2026-10-14

## Context

ADR 0032 defines historical monthly charge evidence. Users also need editable expectations,
income and transfers, nonmonthly schedules, and payment tracking. Reusing RecurringSeries for
those meanings would confuse observed history with an active commitment and rewrite frozen reports.

## Decision

Introduce RecurringPlan and RecurringOccurrence as separate concepts. Dates are local to the
plan's IANA time zone; short months clamp without losing the original anchor. Exact Money stays
separate by Currency. Manual tracking never creates financial Transactions. Transaction association
uses only the Transaction owner's effective facts, and remains distinct from Reconciliation.

One User-owned revision-bound document retains bounded planning state. The existing coordinated
canonical unit commits state and metadata Audit together under live authority. Queries derive
future expectations and unique exact fixed-amount associations observationally. Explicit writes
snapshot effective completions before changing plans or allocations; incomplete bounded reads
cannot establish a safe allocation and refuse the edit. Invalidated associations require review.

Historical detection, its confirmation and discovery semantics, and frozen digest reports remain
unchanged. A reviewed suggestion can create or link a plan, but cannot silently rewrite it. Accounts
remain optional and unavailable until an authoritative Account domain exists. Tracking does not
execute payments, cancel services or add reminders.

## Consequences

Browser and authorized agents share canonical capabilities and revision conflicts. A finite document
and bounded effective-fact reads can refuse further work rather than claim incomplete totals or
allocate ambiguous facts. These limits must remain visible; they must never truncate a complete
monthly result silently. This scoped addition extends planning without amending ADR 0032's detector.
