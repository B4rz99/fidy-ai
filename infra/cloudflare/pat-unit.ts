import { patAtomicAssertion } from "@fidy/server/tokens-runtime";
import type { OwnedStatement } from "@fidy/server/tokens-runtime";

/** Bind a statement published by its owner without reconstructing its table or decision. */
export const prepareOwnedStatement = (
  db: D1Database,
  statement: OwnedStatement
): D1PreparedStatement => db.prepare(statement.sql).bind(...statement.params);

/** Commit a PAT transition only when its final guarded evidence/audit write succeeded.
 * The last statement is a constraint, not a post-commit check: a zero-row guard rolls back
 * the complete D1 batch. The caller keeps all provider effects outside this atomic unit. */
export const commitPATUnit = (
  db: D1Database,
  statements: ReadonlyArray<D1PreparedStatement>
): Promise<Array<D1Result>> => db.batch([...statements, db.prepare(patAtomicAssertion)]);
