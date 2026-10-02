import type { OwnedStatement } from "~/shell/_shared/owned-statement";

/** Bind a statement published by its owner without reconstructing its table or decision. */
export const prepareOwnedStatement = ({
  db,
  statement,
}: Readonly<{ db: D1Database; statement: OwnedStatement }>): D1PreparedStatement =>
  db.prepare(statement.sql).bind(...statement.params);
