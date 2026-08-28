import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds tracked support recovery, bounded authenticated admission, and one-time credential rotation. */
export const supportRecovery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE web_sessions ADD COLUMN source_pairing_id uuid
      REFERENCES browser_login_pairings(id) ON DELETE SET NULL;

    CREATE FUNCTION fidy_capture_web_session_source_pairing() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
    AS $function$
    BEGIN
      NEW.source_pairing_id := (
        SELECT pairing.id FROM public.browser_login_pairings pairing
        WHERE pairing.user_id = NEW.user_id
          AND pairing.lifecycle = 'consumed'
          AND pairing.consumed_at = NEW.paired_at
        ORDER BY pairing.id LIMIT 1
      );
      RETURN NEW;
    END
    $function$;
    CREATE TRIGGER web_session_source_pairing
      BEFORE INSERT ON web_sessions FOR EACH ROW
      EXECUTE FUNCTION fidy_capture_web_session_source_pairing();
    REVOKE ALL ON FUNCTION fidy_capture_web_session_source_pairing() FROM PUBLIC;
  `;

  yield* sql`
    ALTER TABLE backup_recovery_credentials
      ALTER COLUMN code_digest DROP NOT NULL,
      ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      ADD COLUMN consumed_at timestamptz,
      ADD COLUMN last_rotated_by_web_session_id uuid
        REFERENCES web_sessions(id) ON DELETE SET NULL,
      ADD CONSTRAINT backup_recovery_credential_authority CHECK (
        (code_digest IS NOT NULL AND octet_length(code_digest) = 32 AND consumed_at IS NULL)
        OR (code_digest IS NULL AND consumed_at IS NOT NULL)
      )
  `;

  yield* sql`
    CREATE TABLE support_recovery_cases (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pairing_id uuid NOT NULL UNIQUE REFERENCES browser_login_pairings(id) ON DELETE CASCADE,
      credential_revision integer NOT NULL CHECK (credential_revision > 0),
      lifecycle text NOT NULL CHECK (lifecycle IN ('open', 'approved', 'refused', 'expired')),
      opened_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL CHECK (expires_at > opened_at),
      closed_at timestamptz,
      CHECK ((lifecycle = 'open') = (closed_at IS NULL)),
      CHECK (closed_at IS NULL OR (closed_at >= opened_at AND closed_at <= expires_at))
    );
    CREATE UNIQUE INDEX support_recovery_one_open_case_per_user
      ON support_recovery_cases (user_id) WHERE lifecycle = 'open';
    CREATE INDEX support_recovery_terminal_retention
      ON support_recovery_cases (closed_at, id) WHERE lifecycle <> 'open';

    ALTER TABLE backup_recovery_credentials
      ADD COLUMN consumed_by_case_id uuid
        REFERENCES support_recovery_cases(id) ON DELETE SET NULL,
      ADD CONSTRAINT backup_recovery_consumed_case CHECK (
        code_digest IS NULL OR consumed_by_case_id IS NULL
      )
  `;

  yield* sql`
    CREATE TABLE support_recovery_case_events (
      id uuid PRIMARY KEY,
      case_id uuid NOT NULL REFERENCES support_recovery_cases(id) ON DELETE CASCADE,
      ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 7),
      operator_issuer text,
      operator_subject text,
      policy_revision text,
      action text NOT NULL,
      outcome text NOT NULL,
      occurred_at timestamptz NOT NULL,
      UNIQUE (case_id, ordinal),
      CHECK (
        (operator_issuer IS NOT NULL AND operator_subject IS NOT NULL AND policy_revision IS NULL)
        OR (operator_issuer IS NULL AND operator_subject IS NULL
          AND policy_revision = 'support-recovery-expiry-v1')
      ),
      CHECK (
        (action = 'open' AND outcome = 'accepted')
        OR (action = 'decide' AND outcome = 'rejected')
        OR (action = 'approve' AND outcome = 'accepted')
        OR (action = 'close' AND outcome = 'refused')
        OR (action = 'expire' AND outcome = 'expired')
      ),
      CHECK ((action = 'expire') = (policy_revision IS NOT NULL))
    );

    CREATE TABLE support_recovery_admission_attempts (
      operator_issuer text NOT NULL,
      operator_subject text NOT NULL,
      attempted_at timestamptz NOT NULL,
      invocation_count integer NOT NULL CHECK (invocation_count > 0),
      PRIMARY KEY (operator_issuer, operator_subject, attempted_at)
    );
    CREATE INDEX support_recovery_admission_global_time
      ON support_recovery_admission_attempts (attempted_at DESC)
  `;

  yield* sql`
    CREATE FUNCTION fidy_assert_support_recovery_case() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE pairing_expiry timestamptz;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF OLD.lifecycle <> 'open' OR NEW.lifecycle = 'open'
          OR NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
          OR NEW.pairing_id <> OLD.pairing_id
          OR NEW.credential_revision <> OLD.credential_revision
          OR NEW.opened_at <> OLD.opened_at OR NEW.expires_at <> OLD.expires_at
        THEN RAISE EXCEPTION 'SupportRecoveryCase terminal state is immutable'; END IF;
        RETURN NEW;
      END IF;
      SELECT expires_at INTO pairing_expiry FROM browser_login_pairings
      WHERE id = NEW.pairing_id AND lifecycle = 'pending_approval';
      IF pairing_expiry IS NULL OR NEW.expires_at > pairing_expiry THEN
        RAISE EXCEPTION 'SupportRecoveryCase requires one live bounded pairing';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER support_recovery_case_transition
      BEFORE INSERT OR UPDATE ON support_recovery_cases
      FOR EACH ROW EXECUTE FUNCTION fidy_assert_support_recovery_case()
  `;

  yield* sql`
    CREATE FUNCTION fidy_assert_support_recovery_event() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE case_lifecycle text;
    DECLARE expected_ordinal integer;
    DECLARE rejection_count integer;
    DECLARE previous_action text;
    BEGIN
      SELECT lifecycle INTO case_lifecycle FROM support_recovery_cases
      WHERE id = NEW.case_id FOR UPDATE;
      IF case_lifecycle <> 'open' THEN
        RAISE EXCEPTION 'SupportRecoveryCase event requires an open case';
      END IF;
      SELECT COALESCE(max(ordinal), 0) + 1,
        count(*) FILTER (WHERE action = 'decide' AND outcome = 'rejected')
      INTO expected_ordinal, rejection_count
      FROM support_recovery_case_events WHERE case_id = NEW.case_id;
      IF NEW.ordinal <> expected_ordinal THEN
        RAISE EXCEPTION 'SupportRecoveryCase event ordinal is not append-only';
      END IF;
      IF NEW.action = 'open' AND NEW.ordinal <> 1 THEN
        RAISE EXCEPTION 'SupportRecoveryCase opens exactly once';
      END IF;
      IF NEW.action <> 'open' AND NEW.ordinal = 1 THEN
        RAISE EXCEPTION 'SupportRecoveryCase first event must open it';
      END IF;
      IF NEW.action = 'decide' AND rejection_count >= 5 THEN
        RAISE EXCEPTION 'SupportRecoveryCase rejection bound exceeded';
      END IF;
      IF NEW.action = 'close' THEN
        SELECT action INTO previous_action FROM support_recovery_case_events
        WHERE case_id = NEW.case_id AND ordinal = NEW.ordinal - 1;
        IF rejection_count <> 5 OR previous_action <> 'decide' THEN
          RAISE EXCEPTION 'SupportRecoveryCase refusal requires the fifth rejection';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER support_recovery_event_append
      BEFORE INSERT ON support_recovery_case_events
      FOR EACH ROW EXECUTE FUNCTION fidy_assert_support_recovery_event()
  `;

  yield* sql`
    ALTER TABLE support_recovery_cases ENABLE ROW LEVEL SECURITY;
    ALTER TABLE support_recovery_cases FORCE ROW LEVEL SECURITY;
    CREATE POLICY support_recovery_cases_by_user ON support_recovery_cases
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);

    ALTER TABLE support_recovery_case_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE support_recovery_case_events FORCE ROW LEVEL SECURITY;
    CREATE POLICY support_recovery_case_events_by_user ON support_recovery_case_events
      USING (EXISTS (SELECT 1 FROM support_recovery_cases recovery_case
        WHERE recovery_case.id = case_id
          AND recovery_case.user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid))
      WITH CHECK (EXISTS (SELECT 1 FROM support_recovery_cases recovery_case
        WHERE recovery_case.id = case_id
          AND recovery_case.user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid));

    ALTER TABLE support_recovery_admission_attempts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE support_recovery_admission_attempts FORCE ROW LEVEL SECURITY;
    CREATE POLICY support_recovery_admission_anonymous ON support_recovery_admission_attempts
      USING (NULLIF(current_setting('fidy.user_id', true), '') IS NULL)
      WITH CHECK (NULLIF(current_setting('fidy.user_id', true), '') IS NULL)
  `;

  yield* sql`
    CREATE FUNCTION fidy_resolve_support_recovery(bytea, text)
    RETURNS TABLE (user_id uuid, credential_revision integer, pairing_id uuid,
      pairing_expires_at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
      SELECT credential.user_id, credential.revision, pairing.id, pairing.expires_at
      FROM backup_recovery_credentials credential
      JOIN browser_login_pairings pairing ON pairing.public_code = $2
      WHERE octet_length($1) = 32 AND credential.code_digest = $1
        AND credential.consumed_at IS NULL
        AND pairing.lifecycle = 'pending_approval' AND pairing.expires_at > clock_timestamp()
        AND 1 = (
          SELECT count(*) FROM backup_recovery_credentials matching_credential
          WHERE matching_credential.code_digest = $1
            AND matching_credential.consumed_at IS NULL
        )
      LIMIT 1
    $$;

    CREATE FUNCTION fidy_support_recovery_pairing_has_case(uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
      SELECT EXISTS (SELECT 1 FROM support_recovery_cases WHERE pairing_id = $1)
    $$;

    CREATE FUNCTION fidy_backup_recovery_rotation_allowed(uuid, uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
      SELECT COALESCE(bool_or(
        credential.code_digest IS NOT NULL
        OR recovery_case.id = credential.consumed_by_case_id
      ), false)
      FROM backup_recovery_credentials credential
      LEFT JOIN web_sessions session ON session.id = $2 AND session.user_id = credential.user_id
      LEFT JOIN support_recovery_cases recovery_case
        ON recovery_case.pairing_id = session.source_pairing_id
        AND recovery_case.lifecycle = 'approved'
      WHERE credential.user_id = $1
    $$;

    CREATE FUNCTION fidy_has_support_recovery_open_capacity()
    RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
    DECLARE open_case_count integer;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('support-recovery:open-capacity', 0));
      SELECT count(*)::integer INTO open_case_count
      FROM support_recovery_cases WHERE lifecycle = 'open';
      RETURN open_case_count < 100;
    END $$;

    CREATE FUNCTION fidy_expire_support_recovery_cases(timestamptz)
    RETURNS bigint LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
      WITH locked_cases AS MATERIALIZED (
        SELECT id, expires_at FROM support_recovery_cases
        WHERE lifecycle = 'open' AND expires_at <= $1
        ORDER BY expires_at, id LIMIT 500 FOR UPDATE SKIP LOCKED
      ), expired AS MATERIALIZED (
        SELECT recovery_case.id, recovery_case.expires_at,
          (COALESCE(max(event.ordinal), 0) + 1)::integer AS ordinal
        FROM locked_cases recovery_case
        LEFT JOIN support_recovery_case_events event ON event.case_id = recovery_case.id
        GROUP BY recovery_case.id, recovery_case.expires_at
      ), inserted AS (
        INSERT INTO support_recovery_case_events (
          id, case_id, ordinal, policy_revision, action, outcome, occurred_at
        ) SELECT gen_random_uuid(), id, ordinal, 'support-recovery-expiry-v1',
          'expire', 'expired', expires_at FROM expired
        RETURNING case_id, occurred_at
      ), updated AS (
        UPDATE support_recovery_cases recovery_case
        SET lifecycle = 'expired', closed_at = inserted.occurred_at
        FROM inserted WHERE recovery_case.id = inserted.case_id RETURNING 1
      ) SELECT count(*) FROM updated
    $$;

    CREATE FUNCTION fidy_delete_expired_support_recovery(timestamptz)
    RETURNS bigint LANGUAGE sql SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
      WITH expired AS (
        SELECT id FROM support_recovery_cases
        WHERE lifecycle <> 'open' AND closed_at <= $1 - interval '24 months'
        ORDER BY closed_at, id LIMIT 500 FOR UPDATE SKIP LOCKED
      ), deleted AS (
        DELETE FROM support_recovery_cases recovery_case USING expired
        WHERE recovery_case.id = expired.id RETURNING 1
      ) SELECT count(*) FROM deleted
    $$;

    CREATE FUNCTION fidy_delete_support_recovery_for_titular()
    RETURNS void LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, public AS $$
    DECLARE scoped_user_id uuid;
    BEGIN
      scoped_user_id := NULLIF(current_setting('fidy.user_id', true), '')::uuid;
      IF scoped_user_id IS NULL THEN
        RAISE EXCEPTION 'Titular deletion requires one transaction-scoped User';
      END IF;
      DELETE FROM support_recovery_cases WHERE user_id = scoped_user_id;
      DELETE FROM backup_recovery_credentials WHERE user_id = scoped_user_id;
    END $$
  `;

  yield* sql`
    GRANT SELECT, DELETE ON backup_recovery_credentials TO fidy_gateway;
    GRANT SELECT ON browser_login_pairings TO fidy_gateway;
    GRANT SELECT, UPDATE, DELETE ON support_recovery_cases TO fidy_gateway;
    GRANT SELECT, INSERT ON support_recovery_case_events TO fidy_gateway;
    ALTER FUNCTION fidy_resolve_support_recovery(bytea, text) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_support_recovery_pairing_has_case(uuid) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_backup_recovery_rotation_allowed(uuid, uuid) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_has_support_recovery_open_capacity() OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_expire_support_recovery_cases(timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_delete_expired_support_recovery(timestamptz) OWNER TO fidy_gateway;
    ALTER FUNCTION fidy_delete_support_recovery_for_titular() OWNER TO fidy_gateway;
    REVOKE ALL ON FUNCTION fidy_resolve_support_recovery(bytea, text) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_support_recovery_pairing_has_case(uuid) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_backup_recovery_rotation_allowed(uuid, uuid) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_has_support_recovery_open_capacity() FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_expire_support_recovery_cases(timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_delete_expired_support_recovery(timestamptz) FROM PUBLIC;
    REVOKE ALL ON FUNCTION fidy_delete_support_recovery_for_titular() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION fidy_resolve_support_recovery(bytea, text) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_support_recovery_pairing_has_case(uuid) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_backup_recovery_rotation_allowed(uuid, uuid) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_has_support_recovery_open_capacity() TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_expire_support_recovery_cases(timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_delete_expired_support_recovery(timestamptz) TO fidy_runtime;
    GRANT EXECUTE ON FUNCTION fidy_delete_support_recovery_for_titular() TO fidy_runtime;

    REVOKE DELETE ON backup_recovery_credentials FROM fidy_runtime;
    GRANT SELECT, INSERT, UPDATE ON support_recovery_cases TO fidy_runtime;
    GRANT SELECT, INSERT ON support_recovery_case_events TO fidy_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON support_recovery_admission_attempts TO fidy_runtime
  `;
}).pipe(Effect.asVoid);
