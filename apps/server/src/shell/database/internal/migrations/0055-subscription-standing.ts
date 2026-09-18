import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Moves paid Pro standing from Identity into its sole Subscription-owned relation. */
export const subscriptionStanding = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE subscriptions (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      paid_pro_active boolean NOT NULL
    );

    ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
    CREATE POLICY subscriptions_by_user ON subscriptions
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);

    GRANT SELECT, INSERT ON subscriptions TO fidy_runtime;
    GRANT UPDATE (paid_pro_active) ON subscriptions TO fidy_runtime;

    CREATE OR REPLACE FUNCTION fidy_assert_complete_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp AS $$
    DECLARE checked_user_id uuid;
    BEGIN
      checked_user_id := COALESCE(
        to_jsonb(NEW)->>'subject_user_id',
        to_jsonb(OLD)->>'subject_user_id',
        to_jsonb(NEW)->>'user_id',
        to_jsonb(OLD)->>'user_id',
        to_jsonb(NEW)->>'id',
        to_jsonb(OLD)->>'id'
      )::uuid;
      IF EXISTS (SELECT 1 FROM public.users WHERE id = checked_user_id)
      AND (
        NOT EXISTS (SELECT 1 FROM public.whatsapp_identities WHERE user_id = checked_user_id)
        OR NOT EXISTS (
          SELECT 1 FROM public.consent_records WHERE subject_user_id = checked_user_id
          AND event_type = 'granted' AND grant_type = 'onboarding'
        )
        OR NOT EXISTS (
          SELECT 1 FROM public.verified_email_credentials WHERE user_id = checked_user_id
        )
        OR NOT EXISTS (
          SELECT 1 FROM public.backup_recovery_credentials WHERE user_id = checked_user_id
        )
        OR NOT EXISTS (SELECT 1 FROM public.subscriptions WHERE user_id = checked_user_id)
      )
      THEN
        RAISE EXCEPTION 'stable User requires WhatsAppIdentity, ConsentRecord, VerifiedEmailCredential, BackupRecoveryCode, TrialPeriod, and Subscription';
      END IF;
      RETURN NULL;
    END $$;
    REVOKE ALL ON FUNCTION fidy_assert_complete_user() FROM PUBLIC;

    CREATE CONSTRAINT TRIGGER complete_user_from_subscription
    AFTER INSERT OR UPDATE OR DELETE ON subscriptions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fidy_assert_complete_user();

    ALTER TABLE users DROP CONSTRAINT users_paid_tier_check;
    ALTER TABLE users DROP COLUMN paid_tier;
  `;
}).pipe(Effect.asVoid);
