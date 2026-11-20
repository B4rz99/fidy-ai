# Initialize Dashboards explicitly and maintain exact financial projections

- **Status:** Accepted
- **Issues:** #967, #968

## Document lifecycle

`dashboard.getDashboard` and `dashboard.getDashboardView` require read capability and observe an
existing document or a complete ephemeral view. Only genuine absence produces
`dashboard_uninitialized`. Unreadable or corrupt state and incomplete projections return
unavailable. Reads cannot initialize, repair or modify the document.

`dashboard.initializeDashboard` is an explicit, idempotent mutation requiring the Dashboard
capability. Repeated or concurrent initialization preserves the existing content, revision and
Widget identities. The browser attempts initialization once per load after the declared absence
and rereads the result. The normal mutation, authority and Audit rules apply.

A DashboardDocument is a recursive split tree with stable Widget identities. Root resize is
invalid because weight is relative to siblings. A region edit identifies the exact current leaf
set. Canonical leaf order supplies the mobile layout. Adding a catalog template creates an identity,
moving preserves it, and removing the last Widget is refused. Initialization uses the four-Widget
starter layout.

## Financial projection

Transactions owns and writes the effective leaves and exact, per-Currency UTC minute and day
contributions in the same UserStore transaction as changes to effective financial facts. Dashboard
reads the validated document, calendar, effective Transaction pages, aggregate ranges and Budget
caps with its live authority and Audit in the UserStore snapshot. Incomplete totals make the view
unavailable. Paged lists have their own limits and never determine aggregate totals.

Maintain exact contributions on writes because summing only the displayed page understates Money
and scanning all history ties ordinary view cost to lifetime activity. Use current IANA-zone
calendar boundaries to select half-open UTC intervals without rebuilding contributions on a
preference change. Keep amounts separated by Currency and direction. Budget bars consume outflows
in the matching Category and Currency.

[Reconciliation precedence](0030-reversible-reconciliation-links.md) owns effective-fact selection.
[ADR 0041](0041-per-user-durable-object-storage-direction.md) owns the native storage boundary.
The earlier D1 projection and repair schedule are [historical evidence](https://github.com/B4rz99/fidy-ai/blob/f04053571f9f6b4e0ca2d3f891f518880cc6551a/docs/adr/0030-dashboard-exact-write-maintained-projection.md).
