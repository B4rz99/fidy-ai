import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Binds one retained WhatsApp disclosure message to its exact hosted confirmation digest. */
export const whatsappConfirmationEvidence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE whatsapp_message_evidence
      ADD COLUMN confirmation_digest text
      CHECK (confirmation_digest IS NULL OR confirmation_digest ~ '^[0-9a-f]{64}$');
    CREATE UNIQUE INDEX whatsapp_confirmation_disclosure_digest_idx
      ON whatsapp_message_evidence (user_id, confirmation_digest)
      WHERE direction = 'outbound' AND confirmation_digest IS NOT NULL
  `;
}).pipe(Effect.asVoid);
