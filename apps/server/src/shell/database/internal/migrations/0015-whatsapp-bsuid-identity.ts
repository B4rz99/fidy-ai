import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

const discardPhoneAuthorityState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM whatsapp_inbound_jobs`;
  yield* sql`DELETE FROM whatsapp_turn_claims`;
  yield* sql`DELETE FROM whatsapp_conversation_windows`;
  yield* sql`DELETE FROM pending_consent_exchanges`;
  yield* sql`DELETE FROM whatsapp_identities`;
});

const keyIdentitiesByBsuid = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE whatsapp_identities
      ADD COLUMN business_portfolio_id text,
      ADD COLUMN business_scoped_user_id text,
      ADD COLUMN parent_business_scoped_user_id text,
      ADD COLUMN username text,
      DROP CONSTRAINT whatsapp_identities_pkey,
      DROP CONSTRAINT whatsapp_identities_user_id_key,
      ALTER COLUMN phone_number DROP NOT NULL,
      ADD CONSTRAINT whatsapp_identities_bsuid_format CHECK (
        business_scoped_user_id ~* '^[A-Z]{2}\\.[A-Za-z0-9]{1,128}$'
      ),
      ADD CONSTRAINT whatsapp_identities_parent_bsuid_format CHECK (
        parent_business_scoped_user_id IS NULL
        OR parent_business_scoped_user_id ~* '^[A-Z]{2}\\.ENT\\.[A-Za-z0-9]{1,128}$'
      ),
      ADD PRIMARY KEY (business_portfolio_id, business_scoped_user_id),
      ADD UNIQUE (user_id, business_portfolio_id)
  `;
  yield* sql`
    ALTER TABLE whatsapp_identities
      ALTER COLUMN business_portfolio_id SET NOT NULL,
      ALTER COLUMN business_scoped_user_id SET NOT NULL
  `;
});

const keyPendingExchangesByBsuid = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE pending_consent_exchanges
      ADD COLUMN business_portfolio_id text,
      ADD COLUMN business_scoped_user_id text,
      DROP CONSTRAINT pending_consent_exchanges_phone_number_key,
      DROP COLUMN phone_number,
      ADD CONSTRAINT pending_consent_bsuid_format CHECK (
        business_scoped_user_id ~* '^[A-Z]{2}\\.[A-Za-z0-9]{1,128}$'
      ),
      ADD UNIQUE (business_portfolio_id, business_scoped_user_id)
  `;
  yield* sql`
    ALTER TABLE pending_consent_exchanges
      ALTER COLUMN business_portfolio_id SET NOT NULL,
      ALTER COLUMN business_scoped_user_id SET NOT NULL
  `;
});

const keyConversationWindowsByBsuid = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE whatsapp_conversation_windows
      ADD COLUMN business_portfolio_id text,
      ADD COLUMN business_scoped_user_id text
  `;
  yield* sql`
    ALTER TABLE whatsapp_conversation_windows
      ALTER COLUMN business_portfolio_id SET NOT NULL,
      ALTER COLUMN business_scoped_user_id SET NOT NULL
  `;
});

const createIdentityChangeEvidence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE whatsapp_identity_change_evidence (
      provider_message_id text PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      business_portfolio_id text NOT NULL,
      previous_business_scoped_user_id text NOT NULL,
      replacement_business_scoped_user_id text NOT NULL,
      occurred_at timestamptz NOT NULL,
      applied boolean NOT NULL
    )
  `;
  yield* sql`
    ALTER TABLE whatsapp_identity_change_evidence ENABLE ROW LEVEL SECURITY;
    ALTER TABLE whatsapp_identity_change_evidence FORCE ROW LEVEL SECURITY;
    CREATE POLICY whatsapp_identity_change_evidence_by_user
    ON whatsapp_identity_change_evidence
    USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
    WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
  yield* sql`GRANT SELECT, INSERT ON whatsapp_identity_change_evidence TO fidy_gateway`;
  yield* sql`GRANT UPDATE ON whatsapp_identities TO fidy_gateway`;
});

const replaceWhatsAppUserResolver = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP FUNCTION fidy_resolve_whatsapp_user(text)`;
  yield* sql`
    CREATE FUNCTION fidy_resolve_whatsapp_user(
      lookup_business_portfolio_id text,
      lookup_business_scoped_user_id text
    ) RETURNS uuid
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      SELECT identity.user_id
      FROM public.whatsapp_identities AS identity
      WHERE identity.business_portfolio_id = lookup_business_portfolio_id
        AND identity.business_scoped_user_id = lookup_business_scoped_user_id
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_resolve_whatsapp_user(text, text) OWNER TO fidy_gateway;
    REVOKE ALL ON FUNCTION fidy_resolve_whatsapp_user(text, text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_resolve_whatsapp_user(text, text) TO fidy_runtime
  `;
});

const createIdentityReassociationGateway = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE FUNCTION fidy_reassociate_whatsapp_user(
      requested_business_portfolio_id text,
      requested_previous_bsuid text,
      requested_replacement_bsuid text,
      requested_parent_bsuid text,
      requested_username text,
      requested_phone_number text,
      requested_occurred_at timestamptz,
      requested_provider_message_id text
    ) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
    DECLARE
      subject_user_id uuid;
      current_verified_at timestamptz;
    BEGIN
      SELECT evidence.user_id INTO subject_user_id
      FROM public.whatsapp_identity_change_evidence AS evidence
      WHERE evidence.provider_message_id = requested_provider_message_id
        AND evidence.business_portfolio_id = requested_business_portfolio_id
        AND evidence.previous_business_scoped_user_id = requested_previous_bsuid
        AND evidence.replacement_business_scoped_user_id = requested_replacement_bsuid
        AND evidence.occurred_at = requested_occurred_at;
      IF FOUND THEN
        RETURN true;
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.whatsapp_identity_change_evidence AS evidence
        WHERE evidence.provider_message_id = requested_provider_message_id
      ) THEN
        RETURN NULL;
      END IF;

      SELECT identity.user_id, identity.verified_at
      INTO subject_user_id, current_verified_at
      FROM public.whatsapp_identities AS identity
      WHERE identity.business_portfolio_id = requested_business_portfolio_id
        AND identity.business_scoped_user_id = requested_previous_bsuid
      FOR UPDATE;

      IF FOUND THEN
        IF requested_occurred_at >= current_verified_at THEN
          UPDATE public.whatsapp_identities
          SET business_scoped_user_id = requested_replacement_bsuid,
              parent_business_scoped_user_id = requested_parent_bsuid,
              username = requested_username,
              phone_number = requested_phone_number,
              verified_at = requested_occurred_at
          WHERE user_id = subject_user_id
            AND business_portfolio_id = requested_business_portfolio_id
            AND business_scoped_user_id = requested_previous_bsuid;

          INSERT INTO public.whatsapp_identity_change_evidence (
            provider_message_id, user_id, business_portfolio_id,
            previous_business_scoped_user_id, replacement_business_scoped_user_id,
            occurred_at, applied
          ) VALUES (
            requested_provider_message_id, subject_user_id, requested_business_portfolio_id,
            requested_previous_bsuid, requested_replacement_bsuid,
            requested_occurred_at, true
          );
        ELSE
          INSERT INTO public.whatsapp_identity_change_evidence (
            provider_message_id, user_id, business_portfolio_id,
            previous_business_scoped_user_id, replacement_business_scoped_user_id,
            occurred_at, applied
          ) VALUES (
            requested_provider_message_id, subject_user_id, requested_business_portfolio_id,
            requested_previous_bsuid, requested_replacement_bsuid,
            requested_occurred_at, false
          );
        END IF;
        RETURN true;
      END IF;

      SELECT identity.user_id INTO subject_user_id
      FROM public.whatsapp_identities AS identity
      WHERE identity.business_portfolio_id = requested_business_portfolio_id
        AND identity.business_scoped_user_id = requested_replacement_bsuid
      FOR UPDATE;
      IF FOUND THEN
        UPDATE public.whatsapp_identities
        SET parent_business_scoped_user_id = requested_parent_bsuid,
            username = requested_username,
            phone_number = requested_phone_number,
            verified_at = GREATEST(verified_at, requested_occurred_at)
        WHERE user_id = subject_user_id
          AND business_portfolio_id = requested_business_portfolio_id
          AND business_scoped_user_id = requested_replacement_bsuid;

        INSERT INTO public.whatsapp_identity_change_evidence (
          provider_message_id, user_id, business_portfolio_id,
          previous_business_scoped_user_id, replacement_business_scoped_user_id,
          occurred_at, applied
        ) VALUES (
          requested_provider_message_id, subject_user_id, requested_business_portfolio_id,
          requested_previous_bsuid, requested_replacement_bsuid,
          requested_occurred_at, false
        ) ON CONFLICT (provider_message_id) DO NOTHING;
        RETURN true;
      END IF;

      RETURN NULL;
    END
    $function$
  `;
  yield* sql`
    ALTER FUNCTION fidy_reassociate_whatsapp_user(
      text, text, text, text, text, text, timestamptz, text
    ) OWNER TO fidy_gateway;
    REVOKE ALL ON FUNCTION fidy_reassociate_whatsapp_user(
      text, text, text, text, text, text, timestamptz, text
    ) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_reassociate_whatsapp_user(
      text, text, text, text, text, text, timestamptz, text
    ) TO fidy_runtime
  `;
});

/**
 * Replaces the unreleased phone-authority WhatsApp schema with portfolio-scoped BSUID authority.
 * Existing pre-launch associations, pending exchanges, windows, queued jobs, and turn claims are
 * deleted because they were admitted without an authenticated BSUID; User records and other
 * User-owned data remain intact. The migration also replaces the privileged resolver and dies on
 * schema, privilege, or persistence failures.
 */
export const whatsappBsuidIdentity = Effect.gen(function* () {
  yield* discardPhoneAuthorityState;
  yield* keyIdentitiesByBsuid;
  yield* keyPendingExchangesByBsuid;
  yield* keyConversationWindowsByBsuid;
  yield* createIdentityChangeEvidence;
  yield* replaceWhatsAppUserResolver;
  yield* createIdentityReassociationGateway;
}).pipe(Effect.asVoid);
