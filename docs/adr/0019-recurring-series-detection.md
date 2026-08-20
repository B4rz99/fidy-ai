# RecurringSeries detection by same-Currency counterparty rhythm

- **Status:** Accepted
- **Date:** 2026-08-20
- **Active specification:** [Agent-first personal finance MVP for Colombia](https://github.com/B4rz99/fidy-ai/issues/1)
- **Decision map:** [Recurring-charge detection](https://github.com/B4rz99/fidy-ai/issues/24)

## Context

A User wants to be told what they are committed to — `¿qué cargos recurrentes tengo?` — and to be
told once when fidy first notices a new commitment. Both need a rule for deciding that several
Transactions are the same repeating charge.

Two things constrain that rule before any algorithm is chosen.

Money is exact and Currency-scoped (ADR 0001). Amounts in different Currencies are never compared
or added as though they shared a denomination, and fidy performs no FX conversion. A detector that
compared magnitudes across denominations would merge a COP charge with a USD one, and the merged
series would then be a record whose meaning nothing could recover.

Counterparty absence means the Counterparty was not known at capture (CONTEXT.md), and a purpose or
purchased item is not a substitute. A detector that grouped by Category, or that inferred a business
from an amount, would manufacture the exact fact the capture model refuses to guess.

The trigger has a further constraint of its own. `new-recurring-series` is one of the four committed
proactive InsightKinds, and its consumers — the digest, the delivery path, the User — must not
depend on how detection reached its conclusion, or the detector becomes impossible to replace.

## Decision

Detect a RecurringSeries as a **rhythm of comparable same-Currency movements with one
Counterparty**, in the pure core, from Transaction facts alone.

- The grouping key is Counterparty, direction, and Currency together. Currency is part of the key
  rather than a property of the members, so two denominations are two groups by construction and
  no comparison can cross them. A Transaction whose Counterparty was not captured joins no group.
- A group is confirmed at **three or more** occurrences. Two movements are a single interval, and a
  single interval is not yet a rhythm.
- Amounts are comparable when the dearest occurrence exceeds the cheapest by at most **15% of the
  cheapest**, in exact BigDecimal arithmetic. Real charges drift — plans change, taxes apply, usage
  tiers move — so exact equality would miss most of them.
- Cadence is a **named band of whole-day gaps**: weekly 6–8, fortnightly 12–16, monthly 27–33,
  quarterly 84–98, yearly 350–380. Every consecutive gap must fall in the same band. The bands do
  not overlap, so at most one cadence can claim a set of gaps.
- `typicalMoney` is the **most recent occurrence's** amount, not an average. It is what the charge
  currently costs, it is always a value the User actually paid, and it needs no rounding rule.
- Suppression is a closed union carried by the series: `cold-start` while the User's history is
  younger than 30 days, `backfill` when every occurrence predates the instant fidy began watching
  the User. A suppressed series is still listed and still answers questions; only the unprompted
  announcement is withheld.

The trigger reads `summarizeConfirmedSeries`, which reduces the announceable series to
Currency-grouped Money and nothing else. No cadence evidence, tolerance, threshold, or detector
identity reaches a consumer.

This decision does not introduce FX, a second ServiceMarket, a scheduler, or a delivery path.
Emitting the InsightEvent and digesting it belong to the schedule machinery in
[#26](https://github.com/B4rz99/fidy-ai/issues/26) and the digest in
[#29](https://github.com/B4rz99/fidy-ai/issues/29); this ADR fixes only what a confirmed series is
and what the trigger is allowed to say about it.

## Consequences

Detection is a pure function over Transaction facts, so the whole rule is exercised at the core
seam with no database and no clock, and the mutation gate covers every band edge and threshold.
Two instants — `now` and `observedSince` — are parameters rather than ambient reads, which is what
makes the cold-start and backfill decisions testable at their exact boundaries.

Recorded series are a derived read model. Each detection pass upserts what it confirms under the
natural key and forgets what it no longer confirms, so a cancelled subscription stops being listed
rather than lingering. Identity and first-confirmation instant survive re-confirmation, which is
what lets the trigger fire exactly once per commitment.

The thresholds are deliberate and visible in one place. A charge that moves more than 15% between
occurrences, or whose spacing wanders outside a band, is not confirmed — fidy stays quiet rather
than announcing a pattern that is not there. Raising the tolerance is a one-line change with tests
that state the current boundary.

## Rejected alternatives

### Cluster by amount similarity across the whole history

Rejected because amount alone is not identity. Two unrelated charges of 50 000 COP a month apart
would form a series with no Counterparty to name it, and the result could not be shown to a User or
explained afterwards. It would also be the shape most likely to drift into comparing magnitudes
across Currencies.

### Normalize every cadence to a monthly figure so groups can be summed

Rejected because it invents a number the User never pays. A yearly charge is not one twelfth of
itself each month, and a group that mixes cadences has no common period. Totals therefore stay per
occurrence, and the field says so.

### Average the occurrences into a representative amount

Rejected because an average of exact decimals needs a rounding rule, and the rounded result may not
be a legal value in the Currency's precision. The most recent occurrence is exact by construction,
and it is also the more useful answer to "what does this cost me".

### Infer a Counterparty for movements that lack one

Rejected because it contradicts the capture model. Absence records that the Counterparty was not
known, and manufacturing one at detection time would make a derived guess indistinguishable from a
captured fact.

### Suppress backfilled series by hiding them

Rejected because the User's imported history is real and worth answering questions about. Only the
proactive announcement is inappropriate for a charge fidy learned about after the fact, so
suppression withholds the announcement while the series remains listed.
