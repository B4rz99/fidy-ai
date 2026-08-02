# Research 006: PostgreSQL row-level User isolation

Issue: [B4rz99/fidy-ai#81](https://github.com/B4rz99/fidy-ai/issues/81)
Date: 2026-08-01

## Question

How should Fidy add PostgreSQL row-level security beneath its explicit `UserId` application boundary while using Effect SQL pools, preserving narrow pre-subject resolution, and preventing pooled context leakage?

## Primary-source findings

### RLS authority and policy behavior

PostgreSQL applies row-security policies only after `ENABLE ROW LEVEL SECURITY`. If enabled without an applicable policy, access is default-deny. Superusers and roles with `BYPASSRLS` always bypass policies; table owners normally bypass them too, unless the table uses `FORCE ROW LEVEL SECURITY` ([PostgreSQL 17, Row Security Policies](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)). `ALTER TABLE ... FORCE ROW LEVEL SECURITY` is therefore necessary but not sufficient: the runtime login must also be a non-owner, non-superuser role without `BYPASSRLS` ([PostgreSQL 17, ALTER TABLE](https://www.postgresql.org/docs/17/sql-altertable.html)).

Policies can independently constrain visible existing rows with `USING` and candidate inserted or updated rows with `WITH CHECK`. Fidy needs both forms on every User-owned table so all four CRUD shapes are covered ([PostgreSQL 17, CREATE POLICY](https://www.postgresql.org/docs/17/sql-createpolicy.html)).

### Transaction-local User context

`set_config(name, value, true)` has the same transaction-local behavior as `SET LOCAL`; a local value lasts only until transaction end. `current_setting(name, true)` returns `NULL` instead of raising when the custom setting does not exist ([PostgreSQL current, System Administration Functions](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-SET)). PostgreSQL also documents that `SET LOCAL` has no effect outside a transaction and is reverted at commit or rollback ([PostgreSQL current, SET](https://www.postgresql.org/docs/current/sql-set.html)).

Effect SQL's `SqlClient.withTransaction` reserves a transaction connection and publishes it through a transaction context; statements in the wrapped Effect reuse that connection. Nested transactions use savepoints, while top-level completion commits or rolls back and closes the reserved scope (`.repos/effect/packages/effect/src/unstable/sql/SqlClient.ts:121-180`, `.repos/effect/packages/effect/src/unstable/sql/SqlClient.ts:183-230`). The PostgreSQL adapter constructs a managed `pg.Pool`, and pool acquisition/release is scoped (`.repos/effect/packages/sql/pg/src/PgClient.ts:128-183`).

**Conclusion:** establish `fidy.user_id` only inside `SqlClient.withTransaction`, using `set_config(..., true)` on the reserved connection before any User-owned statement. Never establish it with session scope. Repeating the same context in a nested transaction is safe; switching subjects must fail.

### Narrow privileged functions

A `SECURITY DEFINER` function executes with its owner's authority. PostgreSQL warns that such functions need a trusted fixed `search_path`, with `pg_temp` placed last, because otherwise callers can shadow referenced objects. New functions grant `EXECUTE` to `PUBLIC` by default, so creation, revocation from `PUBLIC`, and the narrow grant should occur in one transaction ([PostgreSQL 17, CREATE FUNCTION — Writing SECURITY DEFINER Functions Safely](https://www.postgresql.org/docs/17/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY)).

**Conclusion:** use a `NOLOGIN BYPASSRLS` gateway role with only the underlying table privileges each function needs. Own three fixed-shape functions with it: bearer resolution/use, WhatsApp phone resolution, and global AuditLogEntry retention. Grant the runtime role only `EXECUTE`; do not grant it membership in the gateway role or direct unscoped access that bypasses RLS.

### Role and migration separation

PostgreSQL role attributes are cluster-wide and `BYPASSRLS` is an explicit role attribute ([PostgreSQL current, Role Attributes](https://www.postgresql.org/docs/current/role-attributes.html)). The application must therefore authenticate with the fixed restricted login while migrations use a separate authority able to own schema objects and provision the fixed roles.

Effect's `PgClient.layerConfig` constructs both `PgClient` and the generic `SqlClient` from one configured pool (`.repos/effect/packages/sql/pg/src/PgClient.ts:788-804`). Supplying one such layer to both migrator and runtime would preserve the old shared authority. Two independently configured layers are required.

## Adopted design

1. `MIGRATION_DATABASE_URL` supplies only the boot migrator and setup helpers.
2. `DATABASE_URL` must authenticate with both `session_user` and `current_user` exactly `fidy_runtime`; startup rejects table ownership, superuser, `BYPASSRLS`, or membership that permits assuming any such authority.
3. All User-owned repository operations retain explicit `UserId` and run through one `withUserTransaction` module.
4. Policies read `NULLIF(current_setting('fidy.user_id', true), '')::uuid`, which denies access when context is absent.
5. Parent-owned child tables use `EXISTS` policies through their owning parent.
6. Categories remain global read-only data; the Effect migration journal remains migration-only technical data.
7. Pre-subject lookup and global retention use fixed-input/fixed-output `SECURITY DEFINER` functions owned by `fidy_gateway`.
8. A future queue may claim only opaque work identity through a similarly reviewed narrow gateway, end that transaction, and then enter a separate short User transaction. No model, HTTP, or provider wait belongs inside a User transaction.

## Unresolved questions

None for issue #81. Production provisioning must supply the two URLs and permit the migration authority to provision the fixed roles; that is an operational prerequisite, not an application fallback.
