import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds manual PAT recipient metadata and honest non-provider Consent decision evidence. */
export const manualPATIssuance = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE tokens ADD COLUMN recipient_label text;
    UPDATE tokens SET recipient_label = 'PAT ' || short_id;
    ALTER TABLE tokens
      ALTER COLUMN recipient_label SET NOT NULL,
      ADD CONSTRAINT tokens_recipient_label_check CHECK (
        recipient_label = btrim(recipient_label)
        AND char_length(recipient_label) BETWEEN 1 AND 80
      )
  `;

  yield* sql`
    ALTER TABLE web_sessions
      ADD CONSTRAINT web_sessions_id_user_id_key UNIQUE (id, user_id)
  `;

  yield* sql`
    ALTER TABLE consent_records
      ALTER COLUMN disclosure_channel DROP NOT NULL,
      ALTER COLUMN disclosure_provider DROP NOT NULL,
      ALTER COLUMN disclosure_provider_message_id DROP NOT NULL,
      ALTER COLUMN decision_channel DROP NOT NULL,
      ALTER COLUMN decision_provider DROP NOT NULL,
      ALTER COLUMN decision_provider_message_id DROP NOT NULL,
      ADD COLUMN decision_origin text NOT NULL DEFAULT 'provider-qualified-messages',
      ADD COLUMN web_session_id uuid,
      ADD COLUMN automatic_policy text,
      ADD CONSTRAINT consent_records_decision_origin_check CHECK (
        (
          decision_origin = 'provider-qualified-messages'
          AND disclosure_channel IS NOT NULL
          AND disclosure_provider IS NOT NULL
          AND disclosure_provider_message_id IS NOT NULL
          AND decision_channel IS NOT NULL
          AND decision_provider IS NOT NULL
          AND decision_provider_message_id IS NOT NULL
          AND web_session_id IS NULL
          AND automatic_policy IS NULL
        ) OR (
          decision_origin = 'authenticated-web'
          AND disclosure_channel IS NULL
          AND disclosure_provider IS NULL
          AND disclosure_provider_message_id IS NULL
          AND decision_channel IS NULL
          AND decision_provider IS NULL
          AND decision_provider_message_id IS NULL
          AND web_session_id IS NOT NULL
          AND automatic_policy IS NULL
        ) OR (
          decision_origin = 'automatic-policy'
          AND disclosure_channel IS NULL
          AND disclosure_provider IS NULL
          AND disclosure_provider_message_id IS NULL
          AND decision_channel IS NULL
          AND decision_provider IS NULL
          AND decision_provider_message_id IS NULL
          AND web_session_id IS NULL
          AND automatic_policy IN (
            'pat-approved-unclaimed-expiry', 'pat-inactivity-expiry'
          )
        )
      ),
      ADD CONSTRAINT consent_records_web_session_subject_fkey
        FOREIGN KEY (web_session_id, subject_user_id)
        REFERENCES web_sessions(id, user_id)
  `;

  yield* sql`
    ALTER TABLE consent_records ALTER COLUMN decision_origin DROP DEFAULT
  `;
}).pipe(Effect.asVoid);
