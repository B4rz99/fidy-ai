import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";

export const commitPATUnit = ({
  db,
  statements,
}: Readonly<{ db: D1Database; statements: ReadonlyArray<D1PreparedStatement> }>): Promise<
  Array<D1Result>
> => db.batch([...statements, prepareChangedRowAssertion({ db, scope: "pat_atomic" })]);
