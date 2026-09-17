import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";

/** Deletes browser-session Consent evidence in foreign-key order. */
export const deleteBrowserSessionConsentEvidence = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient
) {
  yield* sql`
    DELETE FROM consent_records
    WHERE revoked_grant_id IN (
      SELECT id FROM consent_records WHERE web_session_id IS NOT NULL
    )
  `;
  yield* sql`DELETE FROM consent_records WHERE web_session_id IS NOT NULL`;
});
