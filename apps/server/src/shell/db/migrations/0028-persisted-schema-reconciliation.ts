import { Data, Effect, Option, Schema, Stream } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { TranscriptEntry, TranscriptEntryId, TranscriptTurnId } from "~/core/transcript/model";

class InvalidLegacyTranscriptEvidence extends Data.TaggedError(
  "InvalidLegacyTranscriptEvidence"
)<{}> {}

const PersistedLegacyTranscriptEntry = Schema.toCodecJson(TranscriptEntry);
const LegacyTranscriptEntryRow = Schema.Struct({
  entryId: TranscriptEntryId,
  turnId: TranscriptTurnId,
  entry: PersistedLegacyTranscriptEntry,
  migrationTime: Schema.DateTimeUtcFromDate,
});
const LegacyInterruptedMarkerRow = Schema.Struct({
  userId: UserId,
  entryId: TranscriptEntryId,
  turnId: TranscriptTurnId,
  terminalAt: Schema.DateTimeUtcFromDate,
});
const LegacyInterruptedMarkerBatch = Schema.Array(LegacyInterruptedMarkerRow);
const encodePersistedLegacyTranscriptEntry = Schema.encodeSync(PersistedLegacyTranscriptEntry);
const legacyTranscriptMarkerBatchSize = 128;

/** Rejects malformed or future-dated legacy Transcript evidence before SQL classifies it. */
const validateLegacyTranscriptEntries = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = sql`
    SELECT
      entry.entry_id AS "entryId",
      entry.turn_id AS "turnId",
      entry.entry,
      CURRENT_TIMESTAMP AS "migrationTime"
    FROM public.transcript_entries AS entry
    LEFT JOIN public.conversation_turns AS turn
      ON turn.user_id = entry.user_id AND turn.id = entry.turn_id
    WHERE turn.id IS NULL
  `.stream;

  yield* Stream.runForEach(rows, (untrusted) =>
    Schema.decodeUnknownEffect(LegacyTranscriptEntryRow)(untrusted).pipe(
      Effect.mapError(() => new InvalidLegacyTranscriptEvidence()),
      Effect.orDie,
      Effect.flatMap((row) =>
        row.entry.id === row.entryId &&
        row.entry.turnId === row.turnId &&
        row.entry.occurredAt.epochMilliseconds <= row.migrationTime.epochMilliseconds
          ? Effect.void
          : Effect.die(new InvalidLegacyTranscriptEvidence())
      )
    )
  );
});

/** Renames the persisted identifiers that changed during the PAT refactor. */
const reconcileLegacyVocabulary = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DO $migration$
    BEGIN
      IF to_regclass('public.agent_tokens') IS NOT NULL
        AND to_regclass('public.tokens') IS NOT NULL THEN
        RAISE EXCEPTION 'Both legacy agent_tokens and current tokens tables exist';
      ELSIF to_regclass('public.agent_tokens') IS NOT NULL THEN
        ALTER TABLE public.agent_tokens RENAME TO tokens;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_log_entries'
          AND column_name = 'token_id'
      ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_log_entries'
          AND column_name = 'pat_id'
      ) THEN
        RAISE EXCEPTION 'Both legacy token_id and current pat_id columns exist on audit_log_entries';
      ELSIF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'audit_log_entries'
          AND column_name = 'token_id'
      ) THEN
        ALTER TABLE public.audit_log_entries RENAME COLUMN token_id TO pat_id;
      END IF;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'consent_records'
          AND column_name = 'agent_token_id'
      ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'consent_records'
          AND column_name = 'pat_id'
      ) THEN
        RAISE EXCEPTION 'Both legacy agent_token_id and current pat_id columns exist on consent_records';
      ELSIF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'consent_records'
          AND column_name = 'agent_token_id'
      ) THEN
        ALTER TABLE public.consent_records RENAME COLUMN agent_token_id TO pat_id;
      END IF;
    END
    $migration$
  `;
});

/** Validates legacy token variants before the migration removes their credential columns. */
const prepareTokenVariantColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE public.tokens
      ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'user',
      ADD COLUMN IF NOT EXISTS expires_at timestamptz
  `;

  yield* sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM public.tokens
        WHERE kind IS NULL OR kind NOT IN ('pat', 'user', 'hosted', 'hosted-turn')
      ) THEN
        RAISE EXCEPTION 'Unknown legacy token kind requires manual review before migration';
      END IF;

      IF EXISTS (
        SELECT 1 FROM public.tokens
        WHERE kind IN ('hosted', 'hosted-turn')
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
      ) THEN
        RAISE EXCEPTION 'Active legacy hosted tokens require manual review before migration';
      END IF;
    END
    $migration$
  `;

  yield* sql`
    DROP INDEX IF EXISTS public.agent_tokens_hosted_expiry_idx;
    DROP INDEX IF EXISTS public.tokens_hosted_turn_expiry_idx;
  `;
});

const reconcileAuditLog = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE public.audit_log_entries
      ADD COLUMN IF NOT EXISTS web_session_id uuid,
      ADD COLUMN IF NOT EXISTS hosted_agent_session_id uuid,
      ALTER COLUMN pat_id DROP NOT NULL,
      DROP CONSTRAINT IF EXISTS audit_log_entries_token_id_fkey,
      DROP CONSTRAINT IF EXISTS audit_log_entries_pat_id_fkey,
      DROP CONSTRAINT IF EXISTS audit_log_entries_exactly_one_caller,
      ADD CONSTRAINT audit_log_entries_pat_id_fkey
        FOREIGN KEY (pat_id) REFERENCES public.tokens(id),
      ADD CONSTRAINT audit_log_entries_exactly_one_caller
        CHECK (num_nonnulls(pat_id, web_session_id, hosted_agent_session_id) = 1)
  `;
});

const reconcileConsentLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE public.consent_records
      DROP CONSTRAINT IF EXISTS consent_records_agent_token_id_subject_user_id_fkey,
      DROP CONSTRAINT IF EXISTS consent_records_pat_id_subject_user_id_fkey,
      DROP CONSTRAINT IF EXISTS consent_records_grant_type_check,
      DROP CONSTRAINT IF EXISTS consent_records_check,
      DROP CONSTRAINT IF EXISTS consent_records_check1
  `;

  yield* sql`
    UPDATE public.consent_records
    SET grant_type = 'pat'
    WHERE grant_type = 'agent-token'
  `;

  yield* sql`
    ALTER TABLE public.consent_records
      ADD CONSTRAINT consent_records_grant_type_check
        CHECK (grant_type IN ('onboarding', 'pat', 'insight-delivery')),
      ADD CONSTRAINT consent_records_check
        CHECK (
          (event_type = 'granted' AND grant_type IS NOT NULL AND revoked_grant_id IS NULL)
          OR
          (event_type = 'revoked' AND grant_type IS NULL AND pat_id IS NULL
            AND insight_kind IS NULL AND revoked_grant_id IS NOT NULL)
        ),
      ADD CONSTRAINT consent_records_check1
        CHECK (
          (grant_type = 'onboarding' AND pat_id IS NULL AND insight_kind IS NULL)
          OR
          (grant_type = 'pat' AND pat_id IS NOT NULL AND insight_kind IS NULL)
          OR
          (grant_type = 'insight-delivery' AND pat_id IS NULL AND insight_kind IS NOT NULL)
          OR grant_type IS NULL
        ),
      ADD CONSTRAINT consent_records_pat_id_subject_user_id_fkey
        FOREIGN KEY (pat_id, subject_user_id)
        REFERENCES public.tokens(id, user_id)
  `;
});

/** Adds the current session tables/columns before historical evidence is attributed. */
const reconcileHostedAgentSessionBase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS public.hosted_agent_sessions (
      user_id uuid NOT NULL REFERENCES public.conversation_continuity(user_id) ON DELETE CASCADE,
      id uuid NOT NULL,
      consent_grant_id uuid NOT NULL REFERENCES public.consent_records(id),
      disclosure_revision text NOT NULL,
      disclosure_sha256 text NOT NULL,
      policy_revision text NOT NULL,
      policy_sha256 text NOT NULL,
      status text NOT NULL CHECK (status IN ('active', 'idle-ended', 'revoked')),
      started_at timestamptz NOT NULL,
      last_terminal_turn_at timestamptz,
      PRIMARY KEY (user_id, id),
      UNIQUE (id),
      CHECK (last_terminal_turn_at IS NULL OR last_terminal_turn_at >= started_at)
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS hosted_agent_sessions_one_active_per_user
      ON public.hosted_agent_sessions (user_id) WHERE status = 'active'
  `;

  yield* sql`
    ALTER TABLE public.hosted_agent_sessions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.hosted_agent_sessions FORCE ROW LEVEL SECURITY;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.hosted_agent_sessions TO fidy_runtime
  `;

  yield* sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'hosted_agent_sessions'
          AND policyname = 'hosted_agent_sessions_by_user'
      ) THEN
        CREATE POLICY hosted_agent_sessions_by_user ON public.hosted_agent_sessions
          USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
          WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid);
      END IF;
    END
    $migration$
  `;

  yield* sql`
    ALTER TABLE public.conversation_turns
      ADD COLUMN IF NOT EXISTS session_id uuid
  `;

  yield* sql`
    ALTER TABLE public.compacted_conversations
      ADD COLUMN IF NOT EXISTS session_id uuid
  `;
});

/** Builds attributable Turns for legacy Transcript content that predates persisted Turn rows. */
const createLegacyTranscriptTurnMap = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TEMP TABLE legacy_transcript_turn_map (
      user_id uuid NOT NULL,
      turn_id uuid NOT NULL,
      started_at timestamptz NOT NULL,
      terminal_at timestamptz NOT NULL,
      activity_terminal_at timestamptz NOT NULL,
      state text,
      failure_reason text,
      needs_interruption_marker boolean NOT NULL,
      PRIMARY KEY (user_id, turn_id)
    ) ON COMMIT DROP
  `;

  yield* sql`
    INSERT INTO pg_temp.legacy_transcript_turn_map (
      user_id,
      turn_id,
      started_at,
      terminal_at,
      activity_terminal_at,
      state,
      failure_reason,
      needs_interruption_marker
    )
    WITH orphan_entries AS (
      SELECT entry.*
      FROM public.transcript_entries AS entry
      LEFT JOIN public.conversation_turns AS turn
        ON turn.user_id = entry.user_id AND turn.id = entry.turn_id
      WHERE turn.id IS NULL
    ),
    tool_calls AS (
      SELECT * FROM orphan_entries
      WHERE entry ->> '_tag' = 'CanonicalToolCallEntry'
    ),
    tool_results AS (
      SELECT * FROM orphan_entries
      WHERE entry ->> '_tag' = 'CanonicalToolResultEntry'
    ),
    tool_pair_counts AS (
      SELECT
        COALESCE(call.user_id, result.user_id) AS user_id,
        COALESCE(call.turn_id, result.turn_id) AS turn_id,
        count(DISTINCT call.sequence) FILTER (
          WHERE result.sequence IS NOT NULL
        ) AS matched_call_count,
        count(DISTINCT result.sequence) FILTER (
          WHERE call.sequence IS NOT NULL
        ) AS matched_result_count
      FROM tool_calls AS call
      FULL OUTER JOIN tool_results AS result
        ON result.user_id = call.user_id
        AND result.turn_id = call.turn_id
        AND result.sequence > call.sequence
        AND result.entry ->> 'iteration' = call.entry ->> 'iteration'
        AND result.entry ->> 'toolCallId' = call.entry ->> 'toolCallId'
        AND result.entry ->> 'operation' = call.entry ->> 'operation'
      GROUP BY COALESCE(call.user_id, result.user_id), COALESCE(call.turn_id, result.turn_id)
    ),
    grouped_entries AS (
      SELECT
        entry.user_id,
        entry.turn_id,
        min((entry.entry ->> 'occurredAt')::timestamptz) AS started_at,
        max((entry.entry ->> 'occurredAt')::timestamptz) AS terminal_at,
        min((entry.entry ->> 'occurredAt')::timestamptz) FILTER (
          WHERE entry.entry ->> '_tag' = 'UserTranscriptEntry'
        ) AS user_occurred_at,
        max((entry.entry ->> 'occurredAt')::timestamptz) FILTER (
          WHERE entry.entry ->> '_tag' = 'AssistantTranscriptEntry'
        ) AS assistant_occurred_at,
        max((entry.entry ->> 'occurredAt')::timestamptz) FILTER (
          WHERE entry.entry ->> '_tag' = 'FailedTurnTranscriptEntry'
        ) AS failed_occurred_at,
        max((entry.entry ->> 'occurredAt')::timestamptz) FILTER (
          WHERE entry.entry ->> '_tag' = 'InterruptedTurnTranscriptEntry'
        ) AS interrupted_occurred_at,
        count(*) AS entry_count,
        min(entry.sequence) AS first_sequence,
        max(entry.sequence) AS last_sequence,
        min(entry.sequence) FILTER (
          WHERE entry.entry ->> '_tag' = 'UserTranscriptEntry'
        ) AS user_sequence,
        max(entry.sequence) FILTER (
          WHERE entry.entry ->> '_tag' = 'AssistantTranscriptEntry'
        ) AS assistant_sequence,
        max(entry.sequence) FILTER (
          WHERE entry.entry ->> '_tag' = 'FailedTurnTranscriptEntry'
        ) AS failed_sequence,
        max(entry.sequence) FILTER (
          WHERE entry.entry ->> '_tag' = 'InterruptedTurnTranscriptEntry'
        ) AS interrupted_sequence,
        count(*) FILTER (
          WHERE entry.entry ->> '_tag' = 'CanonicalToolCallEntry'
        ) AS tool_call_count,
        count(DISTINCT jsonb_build_array(
          entry.entry ->> 'iteration', entry.entry ->> 'toolCallId', entry.entry ->> 'operation'
        )) FILTER (
          WHERE entry.entry ->> '_tag' = 'CanonicalToolCallEntry'
        ) AS distinct_tool_call_count,
        count(*) FILTER (
          WHERE entry.entry ->> '_tag' = 'CanonicalToolResultEntry'
        ) AS tool_result_count,
        count(DISTINCT jsonb_build_array(
          entry.entry ->> 'iteration', entry.entry ->> 'toolCallId', entry.entry ->> 'operation'
        )) FILTER (
          WHERE entry.entry ->> '_tag' = 'CanonicalToolResultEntry'
        ) AS distinct_tool_result_count,
        count(*) FILTER (
          WHERE entry.entry ->> '_tag' = 'UserTranscriptEntry'
        ) AS user_entry_count,
        count(*) FILTER (
          WHERE entry.entry ->> '_tag' = 'AssistantTranscriptEntry'
        ) AS assistant_entry_count,
        count(*) FILTER (
          WHERE entry.entry ->> '_tag' = 'FailedTurnTranscriptEntry'
        ) AS failed_entry_count,
        count(*) FILTER (
          WHERE entry.entry ->> '_tag' = 'InterruptedTurnTranscriptEntry'
        ) AS interrupted_entry_count,
        count(*) FILTER (
          WHERE entry.entry ->> '_tag' IN (
            'UserTranscriptEntry',
            'AssistantTranscriptEntry',
            'CanonicalToolCallEntry',
            'CanonicalToolResultEntry',
            'FailedTurnTranscriptEntry',
            'InterruptedTurnTranscriptEntry'
          )
        ) AS known_entry_count,
        count(DISTINCT entry.entry ->> 'reason') FILTER (
          WHERE entry.entry ->> '_tag' = 'FailedTurnTranscriptEntry'
        ) AS failure_reason_count,
        min(entry.entry ->> 'reason') FILTER (
          WHERE entry.entry ->> '_tag' = 'FailedTurnTranscriptEntry'
        ) AS failure_reason
      FROM orphan_entries AS entry
      GROUP BY entry.user_id, entry.turn_id
    ),
    interleaved_turns AS (
      SELECT DISTINCT grouped.user_id, grouped.turn_id
      FROM grouped_entries AS grouped
      INNER JOIN public.transcript_entries AS interleaved
        ON interleaved.user_id = grouped.user_id
        AND interleaved.turn_id <> grouped.turn_id
        AND interleaved.sequence BETWEEN grouped.first_sequence AND grouped.last_sequence
    ),
    evidence_entries AS (
      SELECT
        grouped.*,
        grouped.tool_call_count = COALESCE(pairs.matched_call_count, 0)
          AND grouped.tool_result_count = COALESCE(pairs.matched_result_count, 0)
          AS tool_pairs_coherent,
        grouped.tool_result_count = COALESCE(pairs.matched_result_count, 0)
          AS tool_results_coherent,
        interleaved.turn_id IS NULL AS sequence_is_contiguous
      FROM grouped_entries AS grouped
      LEFT JOIN tool_pair_counts AS pairs
        ON pairs.user_id = grouped.user_id AND pairs.turn_id = grouped.turn_id
      LEFT JOIN interleaved_turns AS interleaved
        ON interleaved.user_id = grouped.user_id AND interleaved.turn_id = grouped.turn_id
    ),
    classified_entries AS (
      SELECT
        user_id,
        turn_id,
        started_at,
        terminal_at,
        interrupted_entry_count,
        CASE
          WHEN sequence_is_contiguous
            AND entry_count = known_entry_count
            AND user_entry_count = 1
            AND user_sequence = first_sequence
            AND user_occurred_at = started_at
            AND assistant_entry_count = 1
            AND assistant_sequence = last_sequence
            AND assistant_occurred_at = terminal_at
            AND failed_entry_count = 0
            AND interrupted_entry_count = 0
            AND tool_pairs_coherent
            AND tool_call_count = distinct_tool_call_count
            AND tool_result_count = distinct_tool_result_count
            AND tool_call_count = tool_result_count
          THEN 'Completed'
          WHEN sequence_is_contiguous
            AND entry_count = known_entry_count
            AND user_entry_count = 1
            AND user_sequence = first_sequence
            AND user_occurred_at = started_at
            AND assistant_entry_count = 0
            AND failed_entry_count = 1
            AND failed_sequence = last_sequence
            AND failed_occurred_at = terminal_at
            AND interrupted_entry_count = 0
            AND tool_pairs_coherent
            AND tool_call_count = distinct_tool_call_count
            AND tool_result_count = distinct_tool_result_count
            AND tool_call_count = tool_result_count
            AND failure_reason_count = 1
            AND failure_reason IN (
              'HostedInferenceFailed',
              'HostedInferenceTimedOut',
              'DeliveryFailed'
            )
          THEN 'Failed'
          WHEN sequence_is_contiguous
            AND entry_count = known_entry_count
            AND user_entry_count = 1
            AND user_sequence = first_sequence
            AND user_occurred_at = started_at
            AND assistant_entry_count = 0
            AND failed_entry_count = 0
            AND interrupted_entry_count = 1
            AND interrupted_sequence = last_sequence
            AND interrupted_occurred_at = terminal_at
            AND tool_results_coherent
            AND tool_call_count = distinct_tool_call_count
            AND tool_result_count = distinct_tool_result_count
          THEN 'Interrupted'
          WHEN sequence_is_contiguous
            AND entry_count = known_entry_count
            AND user_entry_count = 1
            AND user_sequence = first_sequence
            AND user_occurred_at = started_at
            AND assistant_entry_count = 0
            AND failed_entry_count = 0
            AND interrupted_entry_count = 0
            AND tool_results_coherent
            AND tool_call_count = distinct_tool_call_count
            AND tool_result_count = distinct_tool_result_count
            AND terminal_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'
          THEN 'Interrupted'
          ELSE NULL
        END AS state,
        CASE
          WHEN failed_entry_count = 1 AND failure_reason_count = 1
          THEN failure_reason
          ELSE NULL
        END AS failure_reason
      FROM evidence_entries
    )
    SELECT
      user_id,
      turn_id,
      started_at,
      CASE
        WHEN state = 'Interrupted' AND interrupted_entry_count = 0
        THEN GREATEST(CURRENT_TIMESTAMP, terminal_at)
        ELSE terminal_at
      END AS terminal_at,
      terminal_at AS activity_terminal_at,
      state,
      failure_reason,
      COALESCE(state = 'Interrupted' AND interrupted_entry_count = 0, false)
        AS needs_interruption_marker
    FROM classified_entries
  `;
});

const createLegacyHostedSessionMap = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TEMP TABLE legacy_hosted_session_map (
      user_id uuid PRIMARY KEY,
      session_id uuid NOT NULL,
      consent_grant_id uuid,
      disclosure_revision text,
      disclosure_sha256 text,
      policy_revision text,
      policy_sha256 text,
      consent_occurred_at timestamptz,
      first_evidence_at timestamptz NOT NULL,
      last_evidence_at timestamptz NOT NULL,
      last_terminal_turn_at timestamptz,
      has_pending_turn boolean NOT NULL
    ) ON COMMIT DROP
  `;

  yield* sql`
    INSERT INTO pg_temp.legacy_hosted_session_map (
      user_id,
      session_id,
      consent_grant_id,
      disclosure_revision,
      disclosure_sha256,
      policy_revision,
      policy_sha256,
      consent_occurred_at,
      first_evidence_at,
      last_evidence_at,
      last_terminal_turn_at,
      has_pending_turn
    )
    WITH legacy_evidence AS (
      SELECT
        token.user_id,
        audit.occurred_at AS first_at,
        NULL::timestamptz AS terminal_at,
        false AS is_pending
      FROM public.tokens AS token
      INNER JOIN public.audit_log_entries AS audit ON audit.pat_id = token.id
      WHERE token.kind IN ('hosted', 'hosted-turn')

      UNION ALL

      SELECT
        user_id,
        started_at,
        CASE
          WHEN state IN ('Completed', 'Failed', 'Interrupted') THEN activity_terminal_at
          ELSE NULL
        END,
        false
      FROM pg_temp.legacy_transcript_turn_map

      UNION ALL

      SELECT
        user_id,
        started_at,
        terminal_at,
        state = 'Pending'
      FROM public.conversation_turns
      WHERE session_id IS NULL

      UNION ALL

      SELECT
        user_id,
        updated_at,
        NULL::timestamptz,
        false
      FROM public.compacted_conversations
      WHERE session_id IS NULL
    ),
    grouped_evidence AS (
      SELECT
        user_id,
        min(first_at) AS first_evidence_at,
        max(GREATEST(first_at, terminal_at)) AS last_evidence_at,
        max(terminal_at) AS last_terminal_turn_at,
        bool_or(is_pending) AS has_pending_turn
      FROM legacy_evidence
      GROUP BY user_id
    )
    SELECT
      evidence.user_id,
      gen_random_uuid(),
      consent.id,
      consent.disclosure_revision,
      consent.disclosure_sha256,
      consent.policy_revision,
      consent.policy_sha256,
      consent.occurred_at,
      evidence.first_evidence_at,
      evidence.last_evidence_at,
      evidence.last_terminal_turn_at,
      evidence.has_pending_turn
    FROM grouped_evidence AS evidence
    LEFT JOIN LATERAL (
      SELECT
        id,
        disclosure_revision,
        disclosure_sha256,
        policy_revision,
        policy_sha256,
        occurred_at
      FROM public.consent_records
      WHERE subject_user_id = evidence.user_id
        AND event_type = 'granted'
        AND grant_type = 'onboarding'
        AND occurred_at <= evidence.first_evidence_at
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1
    ) AS consent ON true
  `;
});

const validateLegacyTranscriptTurnMap = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_temp.legacy_transcript_turn_map
        WHERE state IS NULL
      ) THEN
        RAISE EXCEPTION 'Orphan Transcript evidence does not identify a terminal Conversation Turn';
      END IF;
    END
    $migration$
  `;
});

const createLegacyTranscriptTurns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT INTO public.conversation_turns (
      user_id,
      session_id,
      id,
      state,
      started_at,
      terminal_at,
      failure_reason
    )
    SELECT
      transcript.user_id,
      session.session_id,
      transcript.turn_id,
      transcript.state,
      transcript.started_at,
      transcript.terminal_at,
      CASE WHEN transcript.state = 'Failed' THEN transcript.failure_reason ELSE NULL END
    FROM pg_temp.legacy_transcript_turn_map AS transcript
    INNER JOIN pg_temp.legacy_hosted_session_map AS session
      ON session.user_id = transcript.user_id
    WHERE transcript.state IS NOT NULL
  `;
});

/** Appends the schema-encoded recovery marker required for a stale non-terminal Turn. */
const appendLegacyInterruptedTranscriptMarkers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const appendBatch = (
    afterTurnId: Option.Option<TranscriptTurnId>
  ): Effect.Effect<void, SqlError.SqlError> =>
    Effect.gen(function* () {
      const untrusted = Option.isSome(afterTurnId)
        ? yield* sql`
            SELECT
              user_id AS "userId",
              gen_random_uuid() AS "entryId",
              turn_id AS "turnId",
              terminal_at AS "terminalAt"
            FROM pg_temp.legacy_transcript_turn_map
            WHERE needs_interruption_marker AND turn_id > ${afterTurnId.value}
            ORDER BY turn_id
            LIMIT ${legacyTranscriptMarkerBatchSize}
          `
        : yield* sql`
            SELECT
              user_id AS "userId",
              gen_random_uuid() AS "entryId",
              turn_id AS "turnId",
              terminal_at AS "terminalAt"
            FROM pg_temp.legacy_transcript_turn_map
            WHERE needs_interruption_marker
            ORDER BY turn_id
            LIMIT ${legacyTranscriptMarkerBatchSize}
          `;
      const markers = yield* Schema.decodeUnknownEffect(LegacyInterruptedMarkerBatch)(
        untrusted
      ).pipe(Effect.orDie);

      yield* Effect.forEach(markers, (marker) => {
        const entry = encodePersistedLegacyTranscriptEntry({
          _tag: "InterruptedTurnTranscriptEntry",
          id: marker.entryId,
          turnId: marker.turnId,
          occurredAt: marker.terminalAt,
        });
        return sql`
          INSERT INTO public.transcript_entries (user_id, entry_id, turn_id, entry)
          VALUES (${marker.userId}, ${marker.entryId}, ${marker.turnId}, ${entry}::jsonb)
        `;
      });

      if (markers.length === legacyTranscriptMarkerBatchSize) {
        yield* appendBatch(Option.fromUndefinedOr(markers.at(-1)?.turnId));
      }
    });

  yield* appendBatch(Option.none());
});

const validateLegacyHostedEvidence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_temp.legacy_hosted_session_map
        WHERE consent_grant_id IS NULL
      ) THEN
        RAISE EXCEPTION 'Legacy hosted evidence has no attributable onboarding consent grant';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM pg_temp.legacy_hosted_session_map AS session
        INNER JOIN public.consent_records AS consent
          ON consent.subject_user_id = session.user_id
          AND consent.occurred_at <= session.last_evidence_at
          AND (
            (
              consent.event_type = 'granted'
              AND consent.grant_type = 'onboarding'
              AND (
                consent.occurred_at > session.consent_occurred_at
                OR (
                  consent.occurred_at = session.consent_occurred_at
                  AND consent.id <> session.consent_grant_id
                )
              )
            )
            OR (
              consent.event_type = 'revoked'
              AND consent.revoked_grant_id = session.consent_grant_id
            )
          )
      ) THEN
        RAISE EXCEPTION 'Legacy hosted evidence spans distinct onboarding consent periods';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.transcript_entries AS entry
        LEFT JOIN public.conversation_turns AS turn
          ON turn.user_id = entry.user_id AND turn.id = entry.turn_id
        WHERE turn.id IS NULL
      ) THEN
        RAISE EXCEPTION 'Transcript evidence has no attributable Conversation Turn';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.audit_log_entries AS audit
        INNER JOIN public.tokens AS token ON token.id = audit.pat_id
        WHERE token.kind IN ('hosted', 'hosted-turn')
          AND audit.user_id <> token.user_id
      ) THEN
        RAISE EXCEPTION 'Legacy hosted audit evidence has mismatched User attribution';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.consent_records AS consent
        INNER JOIN public.tokens AS token ON token.id = consent.pat_id
        WHERE token.kind IN ('hosted', 'hosted-turn')
      ) THEN
        RAISE EXCEPTION 'Legacy hosted tokens are referenced by consent evidence';
      END IF;
    END
    $migration$
  `;
});

const createLegacyHostedSessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT INTO public.conversation_continuity (user_id)
    SELECT user_id FROM pg_temp.legacy_hosted_session_map
    ON CONFLICT (user_id) DO NOTHING
  `;

  yield* sql`
    INSERT INTO public.hosted_agent_sessions (
      user_id,
      id,
      consent_grant_id,
      disclosure_revision,
      disclosure_sha256,
      policy_revision,
      policy_sha256,
      status,
      started_at,
      last_terminal_turn_at
    )
    SELECT
      user_id,
      session_id,
      consent_grant_id,
      disclosure_revision,
      disclosure_sha256,
      policy_revision,
      policy_sha256,
      CASE
        WHEN has_pending_turn
          OR last_terminal_turn_at > CURRENT_TIMESTAMP - INTERVAL '15 minutes'
        THEN 'active'
        ELSE 'idle-ended'
      END,
      LEAST(first_evidence_at, consent_occurred_at),
      last_terminal_turn_at
    FROM pg_temp.legacy_hosted_session_map
  `;
});

const reassignLegacyHostedAudit = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE public.audit_log_entries AS audit
    SET pat_id = NULL,
      hosted_agent_session_id = map.session_id
    FROM public.tokens AS token
    INNER JOIN pg_temp.legacy_hosted_session_map AS map ON map.user_id = token.user_id
    WHERE audit.pat_id = token.id
      AND token.kind IN ('hosted', 'hosted-turn')
  `;
});

const reassignLegacyHostedTranscript = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE public.conversation_turns AS turn
    SET session_id = map.session_id
    FROM pg_temp.legacy_hosted_session_map AS map
    WHERE turn.user_id = map.user_id AND turn.session_id IS NULL
  `;
});

const reassignLegacyHostedCompactions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE public.compacted_conversations AS compacted
    SET session_id = map.session_id
    FROM pg_temp.legacy_hosted_session_map AS map
    WHERE compacted.user_id = map.user_id AND compacted.session_id IS NULL
  `;
});

const deleteLegacyHostedTokens = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DELETE FROM public.tokens
    WHERE kind IN ('hosted', 'hosted-turn')
  `;
});

const reconcileLegacyHostedEvidence = Effect.gen(function* () {
  yield* validateLegacyTranscriptEntries;
  yield* createLegacyTranscriptTurnMap;
  yield* createLegacyHostedSessionMap;
  yield* validateLegacyTranscriptTurnMap;
  yield* createLegacyHostedSessions;
  yield* createLegacyTranscriptTurns;
  yield* appendLegacyInterruptedTranscriptMarkers;
  yield* validateLegacyHostedEvidence;
  yield* reassignLegacyHostedAudit;
  yield* reassignLegacyHostedTranscript;
  yield* reassignLegacyHostedCompactions;
  yield* deleteLegacyHostedTokens;
});

/** Removes the obsolete hosted-token discriminator after its evidence is session-attributed. */
const removeLegacyTokenVariant = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE public.tokens
      DROP CONSTRAINT IF EXISTS agent_tokens_kind_check,
      DROP CONSTRAINT IF EXISTS agent_tokens_kind_lifetime_check,
      DROP CONSTRAINT IF EXISTS hosted_agent_tokens_all_scopes_check,
      DROP CONSTRAINT IF EXISTS tokens_kind_check,
      DROP CONSTRAINT IF EXISTS tokens_kind_lifetime_check,
      DROP CONSTRAINT IF EXISTS hosted_turn_tokens_all_scopes_check,
      DROP COLUMN kind,
      DROP COLUMN expires_at
  `;
});

/**
 * Reinstalls the current PAT gateway after legacy deployments may have exposed the hosted-token
 * variant. This body intentionally mirrors the original gateway migration: each migration is an
 * immutable, self-contained convergence step and cannot depend on the source text of an earlier
 * migration being present in the deployed database.
 */
const reconcileTokenGateway = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DROP FUNCTION IF EXISTS public.fidy_use_agent_token(text, timestamptz, timestamptz);

    CREATE OR REPLACE FUNCTION public.fidy_use_token(
      lookup_token_hash text,
      use_time timestamptz,
      renewed_idle_expiry timestamptz
    ) RETURNS TABLE (
      token_id uuid,
      subject_user_id uuid,
      scopes text[],
      last_used_at timestamptz
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $function$
      WITH candidate AS MATERIALIZED (
        SELECT id
        FROM public.tokens
        WHERE token_hash = lookup_token_hash AND revoked_at IS NULL
        FOR UPDATE
      ),
      auto_revoked AS (
        UPDATE public.tokens AS token
        SET revoked_at = use_time
        FROM candidate
        WHERE token.id = candidate.id
          AND token.idle_expires_at <= use_time
      ),
      active AS (
        UPDATE public.tokens AS token
        SET last_used_at = GREATEST(token.last_used_at, use_time),
          idle_expires_at = GREATEST(token.idle_expires_at, renewed_idle_expiry)
        FROM candidate
        WHERE token.id = candidate.id
          AND token.idle_expires_at > use_time
        RETURNING token.id, token.user_id, token.scopes, token.last_used_at
      )
      SELECT active.id, active.user_id, active.scopes, active.last_used_at FROM active
    $function$;

    ALTER FUNCTION public.fidy_use_token(text, timestamptz, timestamptz)
      OWNER TO fidy_gateway;
    REVOKE ALL ON FUNCTION public.fidy_use_token(text, timestamptz, timestamptz) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.fidy_use_token(text, timestamptz, timestamptz)
      TO fidy_runtime;
  `;
});

/** Finalizes session foreign keys after all legacy rows have received a session. */
const finalizeHostedAgentSessionSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM public.conversation_turns WHERE session_id IS NULL
      ) THEN
        RAISE EXCEPTION 'Conversation turns remain unattributed to a Hosted Agent Session';
      END IF;

      ALTER TABLE public.conversation_turns ALTER COLUMN session_id SET NOT NULL;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.conversation_turns'::regclass
          AND conname = 'conversation_turns_user_id_session_id_fkey'
      ) THEN
        ALTER TABLE public.conversation_turns
          ADD CONSTRAINT conversation_turns_user_id_session_id_fkey
          FOREIGN KEY (user_id, session_id)
          REFERENCES public.hosted_agent_sessions(user_id, id) ON DELETE CASCADE;
      END IF;
    END
    $migration$
  `;

  yield* sql`
    DO $migration$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM public.compacted_conversations WHERE session_id IS NULL
      ) THEN
        RAISE EXCEPTION 'Compacted conversations remain unattributed to a Hosted Agent Session';
      END IF;

      ALTER TABLE public.compacted_conversations ALTER COLUMN session_id SET NOT NULL;
      ALTER TABLE public.compacted_conversations
        DROP CONSTRAINT IF EXISTS compacted_conversations_pkey;
      ALTER TABLE public.compacted_conversations
        ADD CONSTRAINT compacted_conversations_pkey PRIMARY KEY (user_id, session_id);

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.compacted_conversations'::regclass
          AND conname = 'compacted_conversations_user_id_session_id_fkey'
      ) THEN
        ALTER TABLE public.compacted_conversations
          ADD CONSTRAINT compacted_conversations_user_id_session_id_fkey
          FOREIGN KEY (user_id, session_id)
          REFERENCES public.hosted_agent_sessions(user_id, id) ON DELETE CASCADE;
      END IF;
    END
    $migration$
  `;
});

/**
 * Brings databases created before the PAT and Hosted Agent Session refactors to the current schema.
 * Orphan Transcript groups are decoded and attributed to terminal Turns; malformed, future-dated,
 * non-terminal, or cross-consent-period evidence aborts the migration atomically.
 */
export const persistedSchemaReconciliation = Effect.gen(function* () {
  yield* reconcileLegacyVocabulary;
  yield* prepareTokenVariantColumns;
  yield* reconcileAuditLog;
  yield* reconcileConsentLedger;
  yield* reconcileHostedAgentSessionBase;
  yield* reconcileLegacyHostedEvidence;
  yield* removeLegacyTokenVariant;
  yield* reconcileTokenGateway;
  yield* finalizeHostedAgentSessionSchema;
}).pipe(Effect.asVoid);
