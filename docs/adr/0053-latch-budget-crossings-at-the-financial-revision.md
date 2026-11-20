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

Detection freezes the eligibility and exact Consent grant at the revision of the crossing.
Drain earlier financial revisions before a category opt-in can take effect. Pending publication
must not consult a later grant, and acknowledgment commits with the peer occurrence under the
same User. Old crossings without retained facts stay unavailable. A drain coalesces timestamps
by their own applied month and removes only the version it read so a concurrent writer stays
pending. Unavailable after reconciliation does not prove rollback.

Group Currency and cap plans are versioned by month. Freeze inherited source values at the
change boundary and validate every distinct planned nominal amount before changing the group
Currency. Preserve the exact amounts and refuse incompatible precision. Renames operate on the
explicitly selected same-User collection. The workspace reads plans, spending and unbudgeted
Cash Flow in one authorized snapshot. It validates the common period once and retains each
status's financial checks.
