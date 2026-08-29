import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds replay-safe card enrollment, immutable authorization evidence, and private Wompi sources. */
export const wompiCardEnrollments = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE card_payment_sources (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      wompi_source_id bigint NOT NULL UNIQUE CHECK (wompi_source_id > 0),
      status text NOT NULL CHECK (status = 'available'),
      created_at timestamptz NOT NULL
    );

    CREATE TABLE card_enrollments (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      price_id uuid NOT NULL REFERENCES prices(id),
      billing_email text NOT NULL CHECK (
        billing_email = lower(btrim(billing_email)) AND length(billing_email) <= 254
      ),
      payment_source_mode text NOT NULL CHECK (payment_source_mode IN ('create', 'reuse')),
      status text NOT NULL CHECK (
        status IN ('prepared', 'creating', 'available', 'refused', 'expired', 'verifying')
      ),
      refusal_reason text CHECK (
        refusal_reason IS NULL OR refusal_reason IN (
          'provider-declined', 'provider-error', 'terms-changed'
        )
      ),
      end_user_policy_url text NOT NULL,
      end_user_policy_text text NOT NULL CHECK (length(end_user_policy_text) BETWEEN 1 AND 4096),
      end_user_policy_sha256 text NOT NULL CHECK (end_user_policy_sha256 ~ '^[0-9a-f]{64}$'),
      end_user_policy_provider_hash text NOT NULL CHECK (
        end_user_policy_provider_hash ~ '^[0-9a-f]{32,128}$'
      ),
      personal_auth_url text NOT NULL,
      personal_auth_text text NOT NULL CHECK (length(personal_auth_text) BETWEEN 1 AND 4096),
      personal_auth_sha256 text NOT NULL CHECK (personal_auth_sha256 ~ '^[0-9a-f]{64}$'),
      personal_auth_provider_hash text NOT NULL CHECK (
        personal_auth_provider_hash ~ '^[0-9a-f]{32,128}$'
      ),
      contracts_observed_at timestamptz NOT NULL,
      disclosure_revision text NOT NULL CHECK (disclosure_revision = 'wompi-card-enrollment-v1'),
      disclosure_text text NOT NULL CHECK (length(disclosure_text) BETWEEN 1 AND 4096),
      disclosure_sha256 text NOT NULL CHECK (disclosure_sha256 ~ '^[0-9a-f]{64}$'),
      prepared_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL CHECK (expires_at > prepared_at),
      accepted_at timestamptz,
      payment_source_id uuid REFERENCES card_payment_sources(id),
      CHECK ((status = 'refused') = (refusal_reason IS NOT NULL)),
      CHECK ((status IN ('creating', 'available', 'refused', 'verifying')) = (accepted_at IS NOT NULL)),
      CHECK ((status = 'available') = (payment_source_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX card_enrollments_one_pending_per_user
      ON card_enrollments (user_id)
      WHERE status IN ('prepared', 'creating', 'verifying');
    CREATE INDEX card_enrollments_user_created_idx
      ON card_enrollments (user_id, prepared_at DESC, id);

    CREATE FUNCTION fidy_preserve_card_enrollment_evidence() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.accepted_at IS NOT NULL THEN
          RAISE EXCEPTION 'accepted card enrollment evidence is immutable';
        END IF;
        RETURN OLD;
      END IF;
      IF OLD.accepted_at IS NOT NULL AND (
        NEW.user_id IS DISTINCT FROM OLD.user_id OR
        NEW.price_id IS DISTINCT FROM OLD.price_id OR
        NEW.billing_email IS DISTINCT FROM OLD.billing_email OR
        NEW.payment_source_mode IS DISTINCT FROM OLD.payment_source_mode OR
        NEW.end_user_policy_url IS DISTINCT FROM OLD.end_user_policy_url OR
        NEW.end_user_policy_text IS DISTINCT FROM OLD.end_user_policy_text OR
        NEW.end_user_policy_sha256 IS DISTINCT FROM OLD.end_user_policy_sha256 OR
        NEW.end_user_policy_provider_hash IS DISTINCT FROM OLD.end_user_policy_provider_hash OR
        NEW.personal_auth_url IS DISTINCT FROM OLD.personal_auth_url OR
        NEW.personal_auth_text IS DISTINCT FROM OLD.personal_auth_text OR
        NEW.personal_auth_sha256 IS DISTINCT FROM OLD.personal_auth_sha256 OR
        NEW.personal_auth_provider_hash IS DISTINCT FROM OLD.personal_auth_provider_hash OR
        NEW.contracts_observed_at IS DISTINCT FROM OLD.contracts_observed_at OR
        NEW.disclosure_revision IS DISTINCT FROM OLD.disclosure_revision OR
        NEW.disclosure_text IS DISTINCT FROM OLD.disclosure_text OR
        NEW.disclosure_sha256 IS DISTINCT FROM OLD.disclosure_sha256 OR
        NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
      ) THEN RAISE EXCEPTION 'accepted card enrollment evidence is immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER card_enrollment_evidence_immutable
      BEFORE UPDATE OR DELETE ON card_enrollments
      FOR EACH ROW EXECUTE FUNCTION fidy_preserve_card_enrollment_evidence();

    ALTER TABLE card_payment_sources ENABLE ROW LEVEL SECURITY;
    ALTER TABLE card_payment_sources FORCE ROW LEVEL SECURITY;
    CREATE POLICY card_payment_sources_by_user ON card_payment_sources
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);

    ALTER TABLE card_enrollments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE card_enrollments FORCE ROW LEVEL SECURITY;
    CREATE POLICY card_enrollments_by_user ON card_enrollments
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);

    GRANT SELECT, INSERT ON card_payment_sources, card_enrollments TO fidy_runtime;
    GRANT DELETE ON card_enrollments TO fidy_runtime;
    GRANT UPDATE (billing_email, status, refusal_reason, accepted_at, payment_source_id)
      ON card_enrollments TO fidy_runtime;
  `;
}).pipe(Effect.asVoid);
