# Production recovery

Start from the failed deploy run for the affected stack. Its summary records the commit, the Alchemy output and which verification failed. [Release procedure](production-releases.md)

Revert the offending commit on `trunk` to restore the previous code. A revert changes Worker code only: the same SQLite namespaces, retained alarms, queues, Workflow instances, R2 bytes and provider-side effects continue to exist. Use aggregate state and the private operational health signals to distinguish an unreachable endpoint, unobserved owner work, a failed provider read and a pending Workflow. Keep credentials and financial material in their private owners.

Allow existing owner alarms and Maintenance to resume durable work using the original operation identity. Verify the actual owner receipt, current authority and provider observation before reporting settlement. An ambiguous payment or send uses its existing reconciliation path.

For erasure, inspect the Erasure owner's case and original custody scope with its dedicated authority. Actual deletion, independent R2 disposition and provider custody observations must agree before recording completion. An unresolved custodian remains pending across the platform recovery horizon.
