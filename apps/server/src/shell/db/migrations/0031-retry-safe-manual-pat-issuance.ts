import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds the User-bound request identity that prevents duplicate manual PAT issuance on retry. */
export const retrySafeManualPATIssuance = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE tokens ADD COLUMN issuance_request_id uuid
  `;

  yield* sql`
    CREATE UNIQUE INDEX tokens_user_issuance_request_key
      ON tokens (user_id, issuance_request_id)
      WHERE issuance_request_id IS NOT NULL
  `;
}).pipe(Effect.asVoid);
