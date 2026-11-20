import type { OwnedStatement } from "~/shell/owner-write/contract";
import type { AssertionScope } from "./contract";

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

export const prepareChangedRowAssertion = ({
  db,
  scope,
}: Readonly<{ db: D1Database; scope: AssertionScope }>): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO sql_assertions (scope, accepted)
      VALUES (?, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
      ON CONFLICT(scope) DO UPDATE SET accepted = excluded.accepted`)
    .bind(scope);

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
