import type { OwnedStatement } from "~/shell/owner-write/contract";
import type { AssertionScope } from "./contract";

/** Successful checks write nothing and set changes() to zero. Failure still enters the owned
 * refusal trigger/CHECK constraint, aborting the native batch with its existing classification.
 * Use only where subsequent statements do not depend on a successful assertion changing one row.
 */
export const preparePredicateCheck = ({
  db,
  scope,
  predicate,
}: Readonly<{
  db: D1Database;
  scope: AssertionScope;
  predicate: OwnedStatement;
}>): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO sql_assertions(scope,accepted)
      SELECT ?,0 WHERE NOT EXISTS (${predicate.sql})`)
    .bind(scope, ...predicate.params);

/** Check the previous write only for an existing reservation; success changes no rows. */
export const prepareReservedChangeCheck = ({
  db,
  scope,
  reservation,
}: Readonly<{
  db: D1Database;
  scope: AssertionScope;
  reservation: OwnedStatement;
}>): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO sql_assertions(scope,accepted)
      SELECT ?,0 WHERE EXISTS (${reservation.sql}) AND changes() != 1`)
    .bind(scope, ...reservation.params);

/** Abort the enclosing D1 batch unless the preceding statement changed exactly one row.
 * A successful assertion itself changes one row. Scope separates each caller's fixed slot;
 * it carries no User content and does not establish authorization.
 */
export const prepareChangedRowAssertion = ({
  db,
  scope,
}: Readonly<{ db: D1Database; scope: AssertionScope }>): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO sql_assertions (scope, accepted)
      VALUES (?, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
      ON CONFLICT(scope) DO UPDATE SET accepted = excluded.accepted`)
    .bind(scope);

/** Require one changed row only when the caller's reservation exists; absence writes nothing. */
export const prepareReservedChangeAssertion = ({
  db,
  scope,
  reservation,
}: Readonly<{
  db: D1Database;
  scope: AssertionScope;
  reservation: OwnedStatement;
}>): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO sql_assertions(scope,accepted)
    SELECT ?, CASE WHEN changes() = 1 THEN 1 ELSE 0 END
      WHERE EXISTS (${reservation.sql})
    ON CONFLICT(scope) DO UPDATE SET accepted = excluded.accepted`)
    .bind(scope, ...reservation.params);

/** Abort the enclosing batch unless the owner's authorization or reservation query has a row. */
export const preparePredicateAssertion = ({
  db,
  scope,
  predicate,
}: Readonly<{
  db: D1Database;
  scope: AssertionScope;
  predicate: OwnedStatement;
}>): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO sql_assertions(scope,accepted)
  VALUES (?, CASE WHEN EXISTS (${predicate.sql}) THEN 1 ELSE 0 END)
  ON CONFLICT(scope) DO UPDATE SET accepted=excluded.accepted`)
    .bind(scope, ...predicate.params);
