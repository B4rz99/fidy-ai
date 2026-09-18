import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Lets canonical User-scoped PAT lifecycle operations close approved unclaimed pairings. */
export const patManagement = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`GRANT SELECT, UPDATE ON pat_pairings TO fidy_runtime`;
}).pipe(Effect.asVoid);
