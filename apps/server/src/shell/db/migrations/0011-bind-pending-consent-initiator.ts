import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Binds each temporary exchange to the provider occurrence that initiated disclosure. */
export const bindPendingConsentInitiator = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM pending_consent_exchanges`;
  yield* sql`
    ALTER TABLE pending_consent_exchanges
      ADD COLUMN initiating_channel TEXT NOT NULL,
      ADD COLUMN initiating_provider TEXT NOT NULL,
      ADD COLUMN initiating_provider_message_id TEXT NOT NULL,
      ADD CONSTRAINT pending_consent_initiating_evidence_bounded CHECK (
        char_length(initiating_channel) BETWEEN 1 AND 32
        AND initiating_channel = btrim(initiating_channel)
        AND char_length(initiating_provider) BETWEEN 1 AND 64
        AND initiating_provider = btrim(initiating_provider)
        AND char_length(initiating_provider_message_id) BETWEEN 1 AND 256
        AND initiating_provider_message_id = btrim(initiating_provider_message_id)
      )
  `;
});
