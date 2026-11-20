# Latch Budget crossings at the financial revision

BudgetMonth identifies the local calendar month while the applied IANA zone supplies its
half-open UTC boundaries. Category caps inherit the Budget Group Currency from the effective
month. Evaluate spending in that Currency and preserve same-snapshot unbudgeted outflows.

Each threshold latches once even after a correction reduces spending. A crossing freezes the
cap, observed spending and other financial facts at the triggering revision. It can be delivered
later without recomputing the historical decision. In the D1 adapter, the Transaction commit
writes a versioned evaluation intent, and subsequent corrections drain it before changing the
facts it needs. The native owner records the crossing from its owned revision. Unique threshold
occurrences keep retries from creating another crossing.
