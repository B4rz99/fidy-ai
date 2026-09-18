import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

const createEmailEnrollments = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE pending_consent_exchanges
      ADD COLUMN decision_channel text,
      ADD COLUMN decision_provider text,
      ADD COLUMN decision_provider_message_id text,
      ADD COLUMN accepted_at timestamptz,
      ADD CONSTRAINT pending_consent_accepted_evidence_complete CHECK (
        (decision_channel IS NULL AND decision_provider IS NULL
          AND decision_provider_message_id IS NULL AND accepted_at IS NULL)
        OR
        (decision_channel IS NOT NULL AND decision_provider IS NOT NULL
          AND decision_provider_message_id IS NOT NULL AND accepted_at IS NOT NULL)
      );
    CREATE UNIQUE INDEX pending_consent_decision_evidence_unique
      ON pending_consent_exchanges (
        decision_channel, decision_provider, decision_provider_message_id
      ) WHERE decision_channel IS NOT NULL
  `;
  yield* sql`
    CREATE TABLE email_enrollments (
      id uuid PRIMARY KEY,
      public_code text NOT NULL UNIQUE
        CHECK (public_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$'),
      business_portfolio_id text NOT NULL,
      business_scoped_user_id text NOT NULL,
      parent_business_scoped_user_id text,
      username text,
      phone_number text CHECK (phone_number IS NULL OR phone_number ~ '^\\+[1-9][0-9]{7,14}$'),
      pending_consent_exchange_id uuid NOT NULL UNIQUE REFERENCES pending_consent_exchanges(id),
      expires_at timestamptz NOT NULL,
      email_address text,
      delivery_generation integer NOT NULL DEFAULT 0 CHECK (delivery_generation BETWEEN 0 AND 5),
      resend_available_at timestamptz,
      proof_digest bytea CHECK (proof_digest IS NULL OR octet_length(proof_digest) = 32),
      proof_expires_at timestamptz,
      CHECK ((proof_digest IS NULL) = (proof_expires_at IS NULL)),
      CHECK (proof_expires_at IS NULL OR proof_expires_at <= expires_at),
      wrong_proof_attempts integer NOT NULL DEFAULT 0 CHECK (wrong_proof_attempts BETWEEN 0 AND 4),
      CHECK (
        (email_address IS NULL AND delivery_generation = 0 AND resend_available_at IS NULL
          AND proof_digest IS NULL AND proof_expires_at IS NULL)
        OR
        (email_address IS NOT NULL AND delivery_generation > 0 AND resend_available_at IS NOT NULL)
      ),
      UNIQUE (business_portfolio_id, business_scoped_user_id)
    );
    CREATE INDEX email_enrollments_expiry_idx ON email_enrollments (expires_at, id);
    CREATE INDEX pending_consent_exchanges_expiry_idx
      ON pending_consent_exchanges (expires_at, id)
  `;
  yield* sql`
    CREATE TABLE email_delivery_intents (
      id uuid PRIMARY KEY,
      enrollment_id uuid NOT NULL REFERENCES email_enrollments(id) ON DELETE CASCADE,
      generation integer NOT NULL CHECK (generation BETWEEN 1 AND 5),
      email_address text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'claimed', 'sent', 'rejected', 'uncertain', 'superseded')),
      idempotency_key uuid NOT NULL UNIQUE,
      created_at timestamptz NOT NULL,
      claim_token uuid,
      claim_expires_at timestamptz,
      provider_message_id text,
      CHECK (
        (status = 'claimed') = (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
      ),
      UNIQUE (enrollment_id, generation)
    )
  `;
  yield* sql`
    CREATE INDEX email_delivery_intents_claimable_idx
      ON email_delivery_intents (created_at, id)
      WHERE status IN ('pending', 'claimed')
  `;
  yield* sql`
    CREATE TABLE email_delivery_admission_budgets (
      scope_key text PRIMARY KEY CHECK (scope_key ~ '^[0-9a-f]{64}$'),
      delivery_count integer NOT NULL CHECK (delivery_count BETWEEN 0 AND 5),
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX email_delivery_admission_budgets_expiry_idx
      ON email_delivery_admission_budgets (expires_at)
  `;
  yield* sql`
    CREATE TABLE email_verification_admission_slots (
      slot integer PRIMARY KEY CHECK (slot BETWEEN 1 AND 4)
    );
    INSERT INTO email_verification_admission_slots (slot) VALUES (1), (2), (3), (4)
  `;
});

const createStableCredentials = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE verified_email_credentials (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      email_address text NOT NULL CHECK (email_address = lower(btrim(email_address))),
      verified_at timestamptz NOT NULL
    );
    CREATE UNIQUE INDEX verified_email_credentials_normalized_email_unique
      ON verified_email_credentials (lower(email_address))
  `;
  yield* sql`
    CREATE TABLE backup_recovery_credentials (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      code_digest bytea NOT NULL CHECK (octet_length(code_digest) = 32),
      created_at timestamptz NOT NULL
    )
  `;
  yield* sql`
    ALTER TABLE verified_email_credentials ENABLE ROW LEVEL SECURITY;
    ALTER TABLE verified_email_credentials FORCE ROW LEVEL SECURITY;
    CREATE POLICY verified_email_credentials_by_user ON verified_email_credentials
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);
    ALTER TABLE backup_recovery_credentials ENABLE ROW LEVEL SECURITY;
    ALTER TABLE backup_recovery_credentials FORCE ROW LEVEL SECURITY;
    CREATE POLICY backup_recovery_credentials_by_user ON backup_recovery_credentials
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
});

const createOnboardingConstraintTriggers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE FUNCTION fidy_assert_current_email_delivery_generation() RETURNS trigger
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
              intent.status IN ('pending', 'claimed')
              AND intent.generation <> enrollment.delivery_generation
            )
            OR (
              intent.generation = enrollment.delivery_generation
              AND (
                intent.email_address <> enrollment.email_address
                OR (intent.status = 'pending' AND enrollment.proof_digest IS NOT NULL)
                OR (
                  intent.status IN ('claimed', 'sent', 'rejected', 'uncertain')
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
              AND intent.status IN ('pending', 'claimed', 'sent', 'rejected', 'uncertain')
          )
      ) THEN
        RAISE EXCEPTION 'email delivery intent must fence the current enrollment generation';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER current_email_delivery_from_enrollment
      AFTER INSERT OR UPDATE ON email_enrollments
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION fidy_assert_current_email_delivery_generation();
    CREATE CONSTRAINT TRIGGER current_email_delivery_from_intent
      AFTER INSERT OR UPDATE OR DELETE ON email_delivery_intents
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION fidy_assert_current_email_delivery_generation()
  `;
  yield* sql`
    CREATE FUNCTION fidy_assert_pending_onboarding_complete() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE pending_id uuid;
    BEGIN
      pending_id := COALESCE(
        to_jsonb(NEW)->>'pending_consent_exchange_id',
        to_jsonb(OLD)->>'pending_consent_exchange_id',
        to_jsonb(NEW)->>'id',
        to_jsonb(OLD)->>'id'
      )::uuid;
      IF EXISTS (
        SELECT 1 FROM pending_consent_exchanges AS pending
        WHERE pending.id = pending_id AND pending.accepted_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM email_enrollments AS enrollment
            WHERE enrollment.pending_consent_exchange_id = pending.id
              AND enrollment.expires_at = pending.accepted_at + interval '24 hours'
          )
      ) THEN
        RAISE EXCEPTION 'accepted pending onboarding evidence requires its exact-lifetime enrollment';
      END IF;
      IF EXISTS (
        SELECT 1 FROM email_enrollments AS enrollment
        JOIN pending_consent_exchanges AS pending
          ON pending.id = enrollment.pending_consent_exchange_id
        WHERE pending.id = pending_id
          AND (pending.accepted_at IS NULL
            OR enrollment.expires_at <> pending.accepted_at + interval '24 hours')
      ) THEN
        RAISE EXCEPTION 'email enrollment requires complete accepted Consent evidence';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER pending_onboarding_complete_from_consent
      AFTER INSERT OR UPDATE OR DELETE ON pending_consent_exchanges
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION fidy_assert_pending_onboarding_complete();
    CREATE CONSTRAINT TRIGGER pending_onboarding_complete_from_enrollment
      AFTER INSERT OR UPDATE OR DELETE ON email_enrollments
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION fidy_assert_pending_onboarding_complete()
  `;
  yield* sql`
    CREATE FUNCTION fidy_assert_complete_user() RETURNS trigger
    LANGUAGE plpgsql AS $$
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
      IF EXISTS (SELECT 1 FROM users WHERE id = checked_user_id)
        AND (
          NOT EXISTS (SELECT 1 FROM whatsapp_identities WHERE user_id = checked_user_id)
          OR NOT EXISTS (
            SELECT 1 FROM consent_records WHERE subject_user_id = checked_user_id
              AND event_type = 'granted' AND grant_type = 'onboarding'
          )
          OR NOT EXISTS (SELECT 1 FROM verified_email_credentials WHERE user_id = checked_user_id)
          OR NOT EXISTS (SELECT 1 FROM backup_recovery_credentials WHERE user_id = checked_user_id)
        )
      THEN
        RAISE EXCEPTION 'stable User requires WhatsAppIdentity, ConsentRecord, VerifiedEmailCredential, BackupRecoveryCode, and TrialPeriod';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER complete_user_from_users
      AFTER INSERT OR UPDATE ON users DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      EXECUTE FUNCTION fidy_assert_complete_user();
    CREATE CONSTRAINT TRIGGER complete_user_from_whatsapp
      AFTER INSERT OR UPDATE OR DELETE ON whatsapp_identities
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fidy_assert_complete_user();
    CREATE CONSTRAINT TRIGGER complete_user_from_consent
      AFTER INSERT OR UPDATE OR DELETE ON consent_records
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fidy_assert_complete_user();
    CREATE CONSTRAINT TRIGGER complete_user_from_email
      AFTER INSERT OR UPDATE OR DELETE ON verified_email_credentials
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fidy_assert_complete_user();
    CREATE CONSTRAINT TRIGGER complete_user_from_recovery
      AFTER INSERT OR UPDATE OR DELETE ON backup_recovery_credentials
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fidy_assert_complete_user()
  `;
});

const grantAccess = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    GRANT UPDATE ON pending_consent_exchanges TO fidy_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON email_enrollments TO fidy_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON email_delivery_intents TO fidy_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON email_delivery_admission_budgets TO fidy_runtime;
    GRANT SELECT, UPDATE ON email_verification_admission_slots TO fidy_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON verified_email_credentials TO fidy_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON backup_recovery_credentials TO fidy_runtime
  `;
});

/** Adds bounded pre-User enrollment and mandatory stable verified/recovery credentials. */
export const verifiedEmailOnboarding = Effect.gen(function* () {
  yield* createEmailEnrollments;
  yield* createStableCredentials;
  yield* createOnboardingConstraintTriggers;
  yield* grantAccess;
}).pipe(Effect.asVoid);
