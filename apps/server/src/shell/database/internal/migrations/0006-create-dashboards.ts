import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** One schema-decoded dashboard configuration owned by each User. */
export const createDashboards = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE dashboards (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}).pipe(Effect.asVoid);
