import { patAtomicAssertion } from "../../../src/shell/tokens/operations";

/** Commit a PAT transition only when its final guarded evidence/audit write succeeded.
 * The last statement is a constraint, not a post-commit check: a zero-row guard rolls back
 * the complete D1 batch. The caller keeps all provider effects outside this atomic unit. */
export const commitPATUnit = ({
  db,
  statements,
}: Readonly<{ db: D1Database; statements: ReadonlyArray<D1PreparedStatement> }>): Promise<
  Array<D1Result>
> => db.batch([...statements, db.prepare(patAtomicAssertion)]);
