import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Removes onboarding's execution claims and reserves a schema for Effect-owned durable storage. */
export const effectOnboardingDelivery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE email_delivery_intents AS intent
    SET status = CASE
      WHEN enrollment.proof_digest IS NULL THEN 'pending'
      ELSE 'uncertain'
    END
    FROM email_enrollments AS enrollment
    WHERE intent.enrollment_id = enrollment.id AND intent.status = 'claimed';

    DROP INDEX email_delivery_intents_claimable_idx;

    ALTER TABLE email_delivery_intents
      DROP CONSTRAINT email_delivery_intents_status_check,
      DROP CONSTRAINT email_delivery_intents_check,
      DROP COLUMN claim_token,
      DROP COLUMN claim_expires_at,
      ADD CONSTRAINT email_delivery_intents_status_check CHECK (
        status IN ('pending', 'sent', 'rejected', 'uncertain', 'superseded')
      )
  `;

  yield* sql`
    CREATE OR REPLACE FUNCTION fidy_assert_current_email_delivery_generation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE checked_enrollment_id uuid;
    BEGIN
      checked_enrollment_id := COALESCE(
        (to_jsonb(NEW)->>'enrollment_id')::uuid,
        (to_jsonb(OLD)->>'enrollment_id')::uuid,
        (to_jsonb(NEW)->>'id')::uuid,
        (to_jsonb(OLD)->>'id')::uuid
      );
      IF EXISTS (
        SELECT 1 FROM email_delivery_intents AS intent
        JOIN email_enrollments AS enrollment ON enrollment.id = intent.enrollment_id
        WHERE enrollment.id = checked_enrollment_id
          AND (
            intent.generation > enrollment.delivery_generation
            OR (
              intent.status = 'pending'
              AND intent.generation <> enrollment.delivery_generation
            )
            OR (
              intent.generation = enrollment.delivery_generation
              AND (
                intent.email_address <> enrollment.email_address
                OR (
                  intent.status IN ('sent', 'rejected', 'uncertain')
                  AND enrollment.proof_digest IS NULL
                )
              )
            )
          )
      ) OR EXISTS (
        SELECT 1 FROM email_enrollments AS enrollment
        WHERE enrollment.id = checked_enrollment_id AND enrollment.delivery_generation > 0
          AND NOT EXISTS (
            SELECT 1 FROM email_delivery_intents AS intent
            WHERE intent.enrollment_id = enrollment.id
              AND intent.generation = enrollment.delivery_generation
              AND intent.status IN ('pending', 'sent', 'rejected', 'uncertain')
          )
      ) THEN
        RAISE EXCEPTION 'email delivery intent must fence the current enrollment generation';
      END IF;
      RETURN NULL;
    END $$
  `;

  yield* sql`
    CREATE SCHEMA IF NOT EXISTS fidy_durable;
    ALTER SCHEMA fidy_durable OWNER TO CURRENT_USER;
    REVOKE ALL ON SCHEMA fidy_durable FROM PUBLIC;
    GRANT USAGE, CREATE ON SCHEMA fidy_durable TO fidy_runtime
  `;
}).pipe(Effect.asVoid);
