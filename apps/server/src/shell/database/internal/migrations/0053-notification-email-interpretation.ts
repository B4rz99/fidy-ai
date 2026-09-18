import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds immutable deterministic notification interpretation evidence and fail-closed review reasons. */
export const notificationEmailInterpretation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DELETE FROM forwarded_email_interpretations`;
  yield* sql`
    ALTER TABLE forwarded_email_interpretations
      DROP CONSTRAINT forwarded_email_interpretations_outcome_check,
      DROP CONSTRAINT forwarded_email_interpretations_check,
      ADD COLUMN interpretation_evidence jsonb,
      ADD COLUMN review_reason text,
      ADD CONSTRAINT forwarded_email_interpretations_outcome_check
        CHECK (outcome IN ('interpreted', 'needs-review')),
      ADD CONSTRAINT forwarded_email_interpretations_interpretation_check CHECK (
        (outcome = 'interpreted' AND extraction IS NOT NULL
          AND interpretation_evidence IS NOT NULL AND review_reason IS NULL)
        OR (outcome = 'needs-review' AND extraction IS NULL
          AND interpretation_evidence IS NULL
          AND review_reason IN ('unsupported-content', 'unknown-format',
            'ambiguous-format', 'invalid-format'))
      )
  `;

  yield* sql`ALTER TABLE source_attestations DROP CONSTRAINT source_attestations_source_shape_check`;
  yield* sql`
    ALTER TABLE source_attestations
      ADD COLUMN notification_format_id text,
      ADD COLUMN currency_basis text,
      ADD COLUMN card_last_four text,
      ADD COLUMN account_last_four text,
      ADD COLUMN instrument_label text,
      ADD CONSTRAINT source_attestations_card_last_four_check
        CHECK (card_last_four IS NULL OR card_last_four ~ '^[0-9]{4}$'),
      ADD CONSTRAINT source_attestations_account_last_four_check
        CHECK (account_last_four IS NULL OR account_last_four ~ '^[0-9]{4}$'),
      ADD CONSTRAINT source_attestations_instrument_label_check
        CHECK (instrument_label IS NULL OR (
          char_length(instrument_label) BETWEEN 1 AND 64
          AND instrument_label !~ '[[:cntrl:]]'
        )),
      ADD CONSTRAINT source_attestations_source_shape_check CHECK (
        (kind = 'manual'
          AND statement_submission_id IS NULL AND statement_record_number IS NULL
          AND statement_content_hash IS NULL AND source_format IS NULL AND extractor_revision IS NULL
          AND received_email_id IS NULL AND message_channel IS NULL AND message_provider IS NULL
          AND provider_message_id IS NULL AND message_content_sha256 IS NULL
          AND notification_format_id IS NULL AND currency_basis IS NULL
          AND card_last_four IS NULL AND account_last_four IS NULL AND instrument_label IS NULL)
        OR (kind = 'statement-line'
          AND statement_submission_id IS NOT NULL AND statement_record_number > 0
          AND statement_content_hash IS NOT NULL AND source_format IN ('csv', 'xlsx')
          AND extractor_revision IS NOT NULL AND received_email_id IS NULL
          AND message_channel IS NULL AND message_provider IS NULL
          AND provider_message_id IS NULL AND message_content_sha256 IS NULL
          AND notification_format_id IS NULL AND currency_basis IS NULL
          AND card_last_four IS NULL AND account_last_four IS NULL AND instrument_label IS NULL)
        OR (kind = 'notification-email'
          AND statement_submission_id IS NULL AND statement_record_number IS NULL
          AND statement_content_hash IS NULL AND source_format = 'notification-email'
          AND extractor_revision IS NOT NULL AND received_email_id IS NOT NULL
          AND message_channel = 'email' AND message_provider = 'resend'
          AND provider_message_id IS NOT NULL
          AND message_content_sha256 ~ '^[0-9a-f]{64}$'
          AND (
            (notification_format_id IS NULL AND currency_basis IS NULL
              AND card_last_four IS NULL AND account_last_four IS NULL AND instrument_label IS NULL)
            OR (notification_format_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
              AND currency_basis IN ('explicit', 'format-cop-default-v1'))
          ))
      )
  `;

  yield* sql`ALTER TABLE email_needs_review_items DROP CONSTRAINT email_needs_review_items_check1`;
  yield* sql`
    ALTER TABLE email_needs_review_items
      ADD CONSTRAINT email_needs_review_items_evidence_check CHECK (
        (status = 'pending'
          AND reason IN ('provider-retrieval-failed', 'processing-interrupted')
          AND ingest_sample_id IS NULL)
        OR (status = 'pending' AND reason IN (
          'canonical-validation-failed', 'unsupported-content',
          'unknown-format', 'ambiguous-format', 'invalid-format'
        ) AND ingest_sample_id IS NOT NULL)
        OR (status = 'expired' AND ingest_sample_id IS NULL)
      )
  `;
}).pipe(Effect.asVoid);
