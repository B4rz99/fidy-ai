# PostgreSQL row-level User isolation

- **Status:** Accepted
- **Date:** 2026-08-01
- **Amends:** [ADR-0005](./0005-explicit-user-context-and-isolation.md)

## Context

ADR-0005 deliberately launched with explicit `UserId` application isolation and recorded RLS as a future reinforcement when a non-request path began reading User data. The hosted agent now exists and the first background User-data path is next, so that revisit condition has been met.

RLS remains defense in depth. It must catch an omitted or incorrect relational predicate without hiding the subject from TypeScript, widening pre-subject lookup, leaking context through a pooled connection, or holding a transaction across model/provider work.

PostgreSQL table owners, superusers, and `BYPASSRLS` roles can bypass ordinary policies. AgentToken bearer and WhatsAppIdentity phone lookup must resolve a subject before a User-scoped transaction can exist. AuditLogEntry retention is deliberately global. These authorities need explicit treatment rather than exemptions hidden in repository SQL.

The primary-source basis is recorded in [`research/006-postgresql-row-level-security.md`](../../research/006-postgresql-row-level-security.md).

## Decision

### Authorities and startup

Use two independently configured PostgreSQL pools:

- `MIGRATION_DATABASE_URL` authenticates the separately privileged boot migrator. It owns schema history and can provision the fixed roles.
- `DATABASE_URL` authenticates exactly as `fidy_runtime`, a non-owner, non-superuser login without `BYPASSRLS`.

An idempotent pre-deploy command uses the migration authority to establish the `fidy_runtime` login from the separately configured runtime credential. Before constructing a database client, it requires query-free PostgreSQL URLs targeting the same database and refuses any runtime username except `fidy_runtime`; the credential is transaction-local during provisioning and is not written to migration history. This makes fresh environments self-provisioning without giving the running application schema authority.

Provisioning removes PostgreSQL's default public schema-creation authority. It rejects `fidy_runtime` before rotating its password when the existing role is a superuser, can create roles or databases, can replicate, has `BYPASSRLS`, owns the database, public schema, or any public relation, can create in the database or public schema, or has any direct or transitive role membership. The complete check and password rotation share one transaction, so rejection leaves no partial authority or credential change.

Migrations finish after provisioning and before runtime authority validation or process startup. Startup repeats the same authority check and also fails closed unless both `session_user` and `current_user` are exactly `fidy_runtime`. This rejects owner sessions that begin with `SET ROLE` as well as directly unsafe runtime roles. There is no fallback from the migration URL to the runtime URL or vice versa.

A fixed `fidy_gateway` role is `NOLOGIN`, non-superuser, and `BYPASSRLS`. The runtime role is not its member and cannot assume it through transitive membership. The gateway receives only the table privileges needed by the narrow functions it owns.

### User context and repository interface

`UserId` remains an explicit argument to every repository and core function that needs it. No ambient application `CurrentUser` service is introduced.

The shell's `withUserTransaction(userId, effect)` module:

1. reserves one connection with `SqlClient.withTransaction`;
2. establishes `fidy.user_id` with transaction-local `set_config`;
3. allows nested calls only when they repeat the same User; and
4. commits or rolls back before the connection returns to the pool.

Every User-owned repository operation enters that module. Canonical authorization also wraps the complete state mutation and successful AuditLogEntry in one such transaction. Rejected and failed audit evidence enters its own short User transaction.

No language-model, HTTP, channel, or provider wait occurs in one of these transactions. Hosted-agent transcript and token operations each complete their short User transaction before model generation; canonical tools traverse the ordinary HTTP authorization path.

### Policy coverage

Every User-owned table enables and forces RLS with one explicit policy covering both `USING` and `WITH CHECK`:

| ownership shape             | tables                                                                                                                                                                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| direct User reference       | `whatsapp_identities`, `agent_tokens`, `audit_log_entries`, `consent_records`, `transactions`, `keyword_rules`, `insight_events`, `dashboards`, `transcript_entries`, `whatsapp_message_evidence`, `whatsapp_inbound_jobs`, `whatsapp_turn_claims`, `whatsapp_conversation_windows` |
| User identity is the row id | `users`                                                                                                                                                                                                                                                                             |
| through Transaction         | `source_attestations`                                                                                                                                                                                                                                                               |
| through InsightEvent        | `insight_money_groups`, `insight_delivery_attempts`                                                                                                                                                                                                                                 |

Absent context evaluates to no User and therefore exposes no row. A context for another User cannot read, insert, update, or delete the owner's rows. `consent_records` additionally grants the runtime role only `SELECT` and `INSERT`; revocation and correction append evidence, while update and delete remain unavailable.

`categories` is deliberate global read-only taxonomy data. `whatsapp_ingress_budgets` and `whatsapp_inbound_receipts` are private pre-subject operational state: the runtime has no table privileges and can only consume a bounded permit or claim/complete one authenticated receipt through narrow gateways. The Effect migration journal and PostgreSQL catalog/sequence objects are technical data available only to the authority that needs them; they are not accidental RLS exemptions.

### Pre-subject and global gateways

Use `SECURITY DEFINER` functions with a fixed trusted `search_path`, no `PUBLIC` execution, fixed typed inputs, and minimum output:

- `fidy_use_agent_token` accepts a bearer digest and timestamps, atomically applies expiry/use, and returns only the resolved token id, UserId, scopes, and last-use time.
- `fidy_resolve_whatsapp_user` accepts one normalized phone number and returns only its UserId when associated.
- `fidy_resolve_consent_decision_subject` accepts one provider-qualified decision-message key and returns only the subject UserId already bound to that immutable ConsentRecord. Identity-replay tests prove the result cannot authorize another phone or User.
- `fidy_delete_audit_log_entries_before` accepts one UTC cutoff and performs only the approved global retention deletion.
- `fidy_claim_whatsapp_turn` expires/reclaims unstarted leases and returns either one newly claimed due burst or one expired started claim to retire, exposing only its claim id, stable UserId, and required action; started-claim retirement and content mutation remain behind User-scoped RLS.
- `fidy_consume_whatsapp_budget` atomically consumes one fixed-hour phone or User ingress permit and returns only whether capacity remained; the runtime cannot inspect or mutate budget rows.
- `fidy_claim_whatsapp_receipt`, `fidy_complete_whatsapp_receipt`, and `fidy_release_whatsapp_receipt` serialize one authenticated provider message through terminal consent or queue admission without exposing receipt rows.
- `fidy_prune_whatsapp_operational_data` uses database time to delete only expired ingress budgets and free-form windows, returns no data, and accepts no caller-controlled cutoff.

The runtime role can execute these functions but cannot assume the gateway role or directly bypass policies. New gateways require a new security-boundary review and a negative test; generic privileged SQL is prohibited.

### Background queues

A queue that must discover work before knowing a User may receive a narrow claim function that atomically returns only the work identity and stable UserId required to establish context. Claiming ends its transaction. Processing then enters a separate short `withUserTransaction` call and keeps `UserId` explicit through shell/core calls. Network work happens outside both transactions. A generic cross-User poll query is not permitted.

## Consequences

A missing or wrong User predicate is now blocked by PostgreSQL as well as the application. Transaction-local context cannot survive commit or rollback into a pooled caller. Runtime compromise still permits choosing another valid context through application code, so RLS does not replace authorization or explicit signatures.

Boot now requires two credentials. Local Compose initializes the restricted login; production, CI image smoke tests, and ephemeral environments run the same checked-in pre-deploy provisioning command. An owner credential cannot start the application as its runtime authority.

Repositories pay for short nested transactions when called inside an already-scoped canonical operation. Effect SQL implements those as savepoints on the reserved connection, preserving the outer canonical atomicity.

## Rejected alternatives

### Make the runtime role the table owner and rely on FORCE RLS

Rejected because it leaves schema authority in the long-running process and makes one missed `FORCE` an isolation bypass.

### Use one connection URL and `SET ROLE`

Rejected because the authenticated session still begins with privileged authority, configuration is easy to omit, and migration/runtime separation would not fail closed.

### Put User context in an application service

Rejected for the reasons in ADR-0005: it hides the caller and creates a second subject-propagation path for background work. The PostgreSQL transaction setting is an implementation detail beneath the explicit interface, not application authority.

### Use session-scoped `SET`

Rejected because pooled connections can carry the prior User into unrelated work. Only transaction-local context is accepted.

### Let pre-subject repositories bypass RLS directly

Rejected because broad direct privilege makes every query in those modules a cross-User authority. Fixed-shape functions expose less interface and deny by default.

### Hold one User transaction for an entire hosted turn

Rejected because model and provider latency would pin a connection and transaction, expand lock lifetime, and make cleanup failure operationally dangerous.
