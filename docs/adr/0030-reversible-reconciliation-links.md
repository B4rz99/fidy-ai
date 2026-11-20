# Reversible Reconciliation links over retained Transactions

- **Status:** Accepted
- **Date:** 2026-09-24

Two records can describe the same real-world purchase. Deciding that is Reconciliation: a reversible
process over Transactions, never a merge. Two questions need one written rule each — what a link
stores, and where an effective Transaction is computed.

## A link is one reversible pair decision

`transaction_reconciliation_decisions` stores one canonical ordered pair per User with a state of
`linked` or `keep-separate`, and `transaction_reconciliation_members` gives each linked Transaction
exactly one row. That member primary key is the atomic one-pair-per-Transaction gate: a duplicate,
cyclic, or chained link cannot commit a member, and a concurrent one cannot commit at all. Linking
never rewrites, deletes, or merges either Transaction or any SourceAttestation. The decision insert
also re-asserts that both retained rows still exist and still hold equal Currency, exact amount, and
direction, so a correction that lands between the candidate read and the commit cannot link an
ineligible pair.

An atomic batch that composes a pair mutation attributes a pair premise that moved outside the unit
to that child; a conflict created inside the same batch rolls back with it and stays unattributable,
answering the batch's `unavailable` failure.

Unlinking writes `keep-separate` instead of removing the decision, so the User's decision is
retained and background matching cannot silently recreate the link; an explicit link supersedes it.

## Effective facts are computed on every read

The effective Transaction relation reads each linked pair as one effective Transaction under its
visible member's id, selecting each fact group from the member the Transaction-owned policy selects:
Money, direction, and occurrence from the latest corrected member, else the latest statement-sourced
member, else the visible member; Category, Counterparty, and notes from the latest member that
explicitly decided them, else the visible member. The Transaction owner applies this selection to history, search and the leaves used by
[Dashboard projections](0060-dashboard-initialization-and-exact-projections.md). The link
decision validates eligibility and picks the visible member.

`revision` is the visible member's on every effective row, because the visible member is the identity
history and search return. A single-record read by a suppressed member's id reports that member's
revision instead, so the value a caller reads for an id is exactly the value its correction
compare-and-swaps.

Native storage accepts `statement-line` SourceAttestations, and their precedence participates in
effective-fact selection.

The decision stores only the pair and its visible member, never the current fact authorities.
Authorities move when a member is corrected, and a stored copy would need a refresh hook on every
fact-changing write path — the exact drift this relation exists to prevent.

An explicit authorized link still requires equal exact Money, Currency and direction. The User's
decision resolves timing ambiguity. A field decision includes intentionally clearing Counterparty
or notes, so automatic fact selection cannot replace that absence with an older value. The
inspection surface reads the effective Transaction and its retained originals in one snapshot.

Filter, order and page the effective relation. During projection repair, retained source
history can supply the effective view only when readiness and facts are read together.
Reuse the same User proof on every path. Expose compound ordering keys to SQLite while
dropping them from canonical row decoding. Browser literal search folds the supported
Spanish capitals explicitly because SQLite's ordinary lowercase function handles ASCII.

Group correction fences the complete selected revision and fails atomically on a missing
or stale member. Accepted deletion removes visibility while preserving retained provenance
and updating derived projections. Treat an indexed intra-unit revision repeat as attributable.
An arbitrary premise changed only inside a rolled-back unit can remain unobservable.
