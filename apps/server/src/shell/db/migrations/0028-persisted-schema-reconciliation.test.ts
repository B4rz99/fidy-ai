import { expect, layer } from "@effect/vitest";
import { Cause, Data, Effect, Exit, Option } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import { MigrationSqlClient } from "~/shell/db/client";
import { ApiHarness } from "~/shell/testing/api-harness";
import { persistedSchemaReconciliation } from "./0028-persisted-schema-reconciliation";

class RollbackMigrationFixture extends Data.TaggedError("RollbackMigrationFixture")<{}> {}

const legacyUserId = "f1d1a000-0000-4000-8000-0000000008a1";
const legacyTokenId = "f1d1a000-0000-4000-8000-0000000008a2";
const legacyOnboardingConsentId = "f1d1a000-0000-4000-8000-0000000008a3";
const legacyPatTokenId = "f1d1a000-0000-4000-8000-0000000008a6";
const legacyPatConsentId = "f1d1a000-0000-4000-8000-0000000008a7";
const legacyOrphanTurnId = "f1d1a000-0000-4000-8000-0000000008b1";
const legacyOrphanUserEntryId = "f1d1a000-0000-4000-8000-0000000008b2";
const legacyOrphanAssistantEntryId = "f1d1a000-0000-4000-8000-0000000008b3";
const legacyDuplicateAssistantEntryId = "f1d1a000-0000-4000-8000-0000000008bf";
const legacyUnmatchedToolCallEntryId = "f1d1a000-0000-4000-8000-0000000008c0";
const legacyInterleavedTurnId = "f1d1a000-0000-4000-8000-0000000008c1";
const legacyInterleavedUserEntryId = "f1d1a000-0000-4000-8000-0000000008c2";
const legacyInterleavedAssistantEntryId = "f1d1a000-0000-4000-8000-0000000008c3";
const legacyUnmatchedToolResultEntryId = "f1d1a000-0000-4000-8000-0000000008c4";
const legacyInterruptedResultTurnId = "f1d1a000-0000-4000-8000-0000000008c5";
const legacyInterruptedResultUserEntryId = "f1d1a000-0000-4000-8000-0000000008c6";
const legacyExistingSessionId = "f1d1a000-0000-4000-8000-0000000008c7";
const legacyAmbiguousTurnId = "f1d1a000-0000-4000-8000-0000000008b4";
const legacyAmbiguousEntryId = "f1d1a000-0000-4000-8000-0000000008b5";
const legacyInterruptedTurnId = "f1d1a000-0000-4000-8000-0000000008b6";
const legacyInterruptedUserEntryId = "f1d1a000-0000-4000-8000-0000000008b7";
const legacyInterruptedMarkerEntryId = "f1d1a000-0000-4000-8000-0000000008b8";
const legacyFutureTurnId = "f1d1a000-0000-4000-8000-0000000008b9";
const legacyFutureUserEntryId = "f1d1a000-0000-4000-8000-0000000008ba";
const legacyMalformedTurnId = "f1d1a000-0000-4000-8000-0000000008bd";
const legacyMalformedEntryId = "f1d1a000-0000-4000-8000-0000000008be";
const laterOnboardingConsentId = "f1d1a000-0000-4000-8000-0000000008bb";
const onboardingRevocationId = "f1d1a000-0000-4000-8000-0000000008bc";

const prepareLegacyTableShape = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;

  // Migration reconciliation scans legacy evidence globally; isolate this transactional fixture
  // from rows left by other persistence tests.
  yield* sql`TRUNCATE TABLE users CASCADE`;
  yield* sql`ALTER TABLE tokens RENAME TO agent_tokens`;
  yield* sql`ALTER TABLE audit_log_entries RENAME COLUMN pat_id TO token_id`;
  yield* sql`ALTER TABLE consent_records RENAME COLUMN pat_id TO agent_token_id`;
  yield* sql`
    ALTER TABLE agent_tokens
      ADD COLUMN kind text NOT NULL DEFAULT 'pat',
      ADD COLUMN expires_at timestamptz
  `;
  yield* sql`
    INSERT INTO users (
      id, service_market, locale, time_zone, paid_tier,
      trial_started_at, trial_ends_at, created_at
    ) VALUES (
      ${legacyUserId}, 'CO', 'es-CO', 'America/Bogota', 'free',
      '2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z', '2026-01-01T00:00:00Z'
    )
  `;
});

type LegacyTokenFixture = {
  readonly tokenId: string;
  readonly shortId: string;
  readonly tokenHash: string;
  readonly kind: "pat" | "hosted-turn";
  readonly revokedAt: Option.Option<string>;
  readonly expiresAt: Option.Option<string>;
};

const makeLegacyTokenFixture = (
  overrides: Partial<LegacyTokenFixture> = {}
): LegacyTokenFixture => ({
  tokenId: legacyTokenId,
  shortId: "legacy81",
  tokenHash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  kind: "hosted-turn",
  revokedAt: Option.none(),
  expiresAt: Option.some("2099-01-02T00:00:00Z"),
  ...overrides,
});

const insertLegacyToken = (
  fixture: LegacyTokenFixture
): Effect.Effect<void, SqlError.SqlError, MigrationSqlClient> =>
  Effect.gen(function* () {
    const sql = yield* MigrationSqlClient;
    const revokedAtValue = Option.match(fixture.revokedAt, {
      onNone: () => sql`NULL`,
      onSome: (present) => sql`${present}`,
    });
    const expiresAtValue = Option.match(fixture.expiresAt, {
      onNone: () => sql`NULL`,
      onSome: (present) => sql`${present}`,
    });
    yield* sql`
      INSERT INTO agent_tokens (
        id, user_id, short_id, recipient_label, token_hash, scopes,
        last_used_at, idle_expires_at, revoked_at, created_at, kind, expires_at
      ) VALUES (
        ${fixture.tokenId}, ${legacyUserId}, ${fixture.shortId}, 'Legacy PAT',
        ${fixture.tokenHash},
        ARRAY['read']::text[], NULL, '2026-04-01T00:00:00Z',
        ${revokedAtValue},
        '2026-01-01T00:00:00Z', ${fixture.kind},
        ${expiresAtValue}
      )
    `;
  });

const insertLegacyConsent = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`
    INSERT INTO consent_records (
      id, subject_user_id, event_type, grant_type, insight_kind, revoked_grant_id,
      service_market, locale, disclosure_revision, disclosure_sha256, disclosure_text,
      policy_url, policy_revision, policy_sha256, purposes, data_categories, duration,
      revocation_method, disclosure_channel, disclosure_provider, disclosure_provider_message_id,
      decision_channel, decision_provider, decision_provider_message_id, decision_origin, occurred_at
    ) VALUES (
      ${legacyOnboardingConsentId}, ${legacyUserId}, 'granted', 'onboarding',
      NULL, NULL, 'CO', 'es-CO', 'onboarding-test',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'test disclosure',
      'https://example.test/policy', 'policy-test',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      ARRAY['test']::text[], ARRAY['test']::text[], 'test duration', 'test revocation',
      'whatsapp', 'kapso', 'legacy-disclosure', 'whatsapp', 'kapso', 'legacy-decision',
      'provider-qualified-messages', '2026-01-01T00:00:00Z'
    )
  `;
});

const insertLegacyPatConsent = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`
    INSERT INTO consent_records (
      id, subject_user_id, event_type, grant_type, insight_kind, revoked_grant_id, agent_token_id,
      service_market, locale, disclosure_revision, disclosure_sha256, disclosure_text,
      policy_url, policy_revision, policy_sha256, purposes, data_categories, duration,
      revocation_method, disclosure_channel, disclosure_provider, disclosure_provider_message_id,
      decision_channel, decision_provider, decision_provider_message_id, decision_origin, occurred_at
    ) VALUES (
      ${legacyPatConsentId}, ${legacyUserId}, 'granted', 'pat', NULL, NULL, ${legacyPatTokenId},
      'CO', 'es-CO', 'pat-test',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'test disclosure',
      'https://example.test/policy', 'policy-test',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      ARRAY['test']::text[], ARRAY['test']::text[], 'test duration', 'test revocation',
      'whatsapp', 'kapso', 'legacy-pat-disclosure', 'whatsapp', 'kapso', 'legacy-pat-decision',
      'provider-qualified-messages', '2026-01-01T12:00:00Z'
    )
  `;
});

const insertLegacyOrphanTranscript = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* sql`
    INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
    VALUES
      (
        ${legacyUserId},
        ${legacyOrphanUserEntryId},
        ${legacyOrphanTurnId},
        jsonb_build_object(
          '_tag', 'UserTranscriptEntry',
          'id', ${legacyOrphanUserEntryId}::text,
          'turnId', ${legacyOrphanTurnId}::text,
          'occurredAt', '2026-01-02T00:00:00Z',
          'text', 'legacy request'
        )
      ),
      (
        ${legacyUserId},
        ${legacyOrphanAssistantEntryId},
        ${legacyOrphanTurnId},
        jsonb_build_object(
          '_tag', 'AssistantTranscriptEntry',
          'id', ${legacyOrphanAssistantEntryId}::text,
          'turnId', ${legacyOrphanTurnId}::text,
          'occurredAt', '2026-01-02T00:01:00Z',
          'iteration', 1,
          'text', 'legacy response'
        )
      )
  `;
});

/** Restores the pre-session schema shared by orphan Transcript reconciliation fixtures. */
const prepareLegacyOrphanTranscriptShape = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* prepareLegacyTableShape;
  yield* insertLegacyConsent;
  yield* sql`ALTER TABLE conversation_turns DROP CONSTRAINT conversation_turns_user_id_session_id_fkey`;
  yield* sql`ALTER TABLE conversation_turns DROP COLUMN session_id`;
});

const runPersistedSchemaReconciliation = Effect.gen(function* () {
  const admin = yield* MigrationSqlClient;
  return yield* persistedSchemaReconciliation.pipe(
    Effect.provideService(SqlClient.SqlClient, admin)
  );
});

const insertLegacyHostedEvidence = Effect.gen(function* () {
  const sql = yield* MigrationSqlClient;
  yield* insertLegacyConsent;
  yield* sql`
    INSERT INTO audit_log_entries (
      id, user_id, token_id, operation, outcome, occurred_at
    ) VALUES (
      'f1d1a000-0000-4000-8000-0000000008a4', ${legacyUserId}, ${legacyTokenId},
      'transactions.createTransaction', 'succeeded', '2026-01-02T00:00:00Z'
    )
  `;
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "persisted schema reconciliation",
  (it) => {
    it.effect("rejects an active legacy hosted token and rolls back the fixture", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyTableShape;
              yield* insertLegacyToken(makeLegacyTokenFixture());

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isFailure(migrationExit)).toBe(true);
              if (Exit.isFailure(migrationExit)) {
                expect(Cause.pretty(migrationExit.cause)).toContain(
                  "Active legacy hosted tokens require manual review"
                );
              }
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
        expect(
          yield* admin`
            SELECT count(*)::int AS count
            FROM pg_catalog.pg_class
            WHERE relnamespace = 'public'::regnamespace AND relname = 'tokens'
          `
        ).toEqual([{ count: 1 }]);
        expect(
          yield* admin`
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'tokens'
              AND column_name IN ('kind', 'expires_at')
          `
        ).toEqual([]);
      })
    );

    it.effect("removes an expired legacy hosted token without manual review", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyTableShape;
              yield* insertLegacyToken(
                makeLegacyTokenFixture({ expiresAt: Option.some("2000-01-02T00:00:00Z") })
              );

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isSuccess(migrationExit)).toBe(true);
              expect(
                yield* admin`
                  SELECT id
                  FROM tokens
                  WHERE id = ${legacyTokenId}
                `
              ).toEqual([]);
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("keeps a legacy PAT and removes only the obsolete variant shape", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyTableShape;
              yield* insertLegacyToken(
                makeLegacyTokenFixture({ kind: "pat", expiresAt: Option.none() })
              );

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isSuccess(migrationExit)).toBe(true);
              expect(
                yield* admin`
                  SELECT id
                  FROM tokens
                  WHERE id = ${legacyTokenId}
                `
              ).toEqual([{ id: legacyTokenId }]);
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("moves revoked hosted audit evidence to a session before removing its token", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyTableShape;
              yield* insertLegacyToken(
                makeLegacyTokenFixture({ revokedAt: Option.some("2026-01-03T00:00:00Z") })
              );
              yield* insertLegacyHostedEvidence;
              yield* insertLegacyToken(
                makeLegacyTokenFixture({
                  tokenId: legacyPatTokenId,
                  shortId: "legacy82",
                  tokenHash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                  kind: "pat",
                  expiresAt: Option.none(),
                })
              );
              yield* insertLegacyPatConsent;

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isSuccess(migrationExit)).toBe(true);
              expect(
                yield* admin`
                  SELECT id
                  FROM tokens
                  WHERE id = ${legacyTokenId}
                `
              ).toEqual([]);
              expect(
                yield* admin`
                  SELECT pat_id IS NULL AS pat_id_absent, hosted_agent_session_id
                  FROM audit_log_entries
                  WHERE id = 'f1d1a000-0000-4000-8000-0000000008a4'
                `
              ).toMatchObject([{ pat_id_absent: true }]);
              expect(
                yield* admin`
                  SELECT status, consent_grant_id
                  FROM hosted_agent_sessions
                  WHERE user_id = ${legacyUserId}
                `
              ).toEqual([{ status: "idle-ended", consent_grant_id: legacyOnboardingConsentId }]);
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("keeps a recently terminal legacy session active", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyTableShape;
              yield* insertLegacyConsent;
              yield* admin`INSERT INTO conversation_continuity (user_id) VALUES (${legacyUserId})`;
              yield* admin`ALTER TABLE conversation_turns DROP CONSTRAINT conversation_turns_user_id_session_id_fkey`;
              yield* admin`ALTER TABLE conversation_turns DROP COLUMN session_id`;
              yield* admin`
                INSERT INTO conversation_turns (
                  user_id, id, state, started_at, terminal_at, failure_reason
                ) VALUES (
                  ${legacyUserId}, 'f1d1a000-0000-4000-8000-000000000aa1',
                  'Completed', CURRENT_TIMESTAMP - INTERVAL '2 minutes',
                  CURRENT_TIMESTAMP - INTERVAL '1 minute', NULL
                )
              `;

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isSuccess(migrationExit)).toBe(true);
              expect(
                yield* admin`
                  SELECT status
                  FROM hosted_agent_sessions
                  WHERE user_id = ${legacyUserId}
                `
              ).toEqual([{ status: "active" }]);
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("creates a completed Turn for an orphaned complete Transcript", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyOrphanTranscriptShape;
              yield* insertLegacyOrphanTranscript;

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isSuccess(migrationExit)).toBe(true);
              expect(
                yield* admin`
                  SELECT state, failure_reason, session_id IS NOT NULL AS has_session
                  FROM conversation_turns
                  WHERE user_id = ${legacyUserId} AND id = ${legacyOrphanTurnId}
                `
              ).toEqual([{ state: "Completed", failure_reason: null, has_session: true }]);
              expect(
                yield* admin`
                  SELECT count(*)::int AS count
                  FROM transcript_entries AS entry
                  INNER JOIN conversation_turns AS turn
                    ON turn.user_id = entry.user_id AND turn.id = entry.turn_id
                  WHERE entry.user_id = ${legacyUserId}
                `
              ).toEqual([{ count: 2 }]);
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("recovers a stale orphaned Transcript as an Interrupted Turn", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyOrphanTranscriptShape;
              yield* admin`
                INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
                VALUES (
                  ${legacyUserId},
                  ${legacyInterruptedUserEntryId},
                  ${legacyInterruptedTurnId},
                  jsonb_build_object(
                    '_tag', 'UserTranscriptEntry',
                    'id', ${legacyInterruptedUserEntryId}::text,
                    'turnId', ${legacyInterruptedTurnId}::text,
                    'occurredAt', '2026-01-02T00:00:00Z',
                    'text', 'legacy abandoned request'
                  )
                )
              `;

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isSuccess(migrationExit)).toBe(true);
              expect(
                yield* admin`
                  SELECT turn.state, turn.failure_reason,
                    turn.session_id IS NOT NULL AS has_session,
                    turn.terminal_at >= turn.started_at AS terminal_after_start,
                    session.status AS session_status
                  FROM conversation_turns AS turn
                  INNER JOIN hosted_agent_sessions AS session
                    ON session.user_id = turn.user_id AND session.id = turn.session_id
                  WHERE turn.user_id = ${legacyUserId} AND turn.id = ${legacyInterruptedTurnId}
                `
              ).toEqual([
                {
                  state: "Interrupted",
                  failure_reason: null,
                  has_session: true,
                  terminal_after_start: true,
                  session_status: "idle-ended",
                },
              ]);
              expect(
                yield* admin`
                  SELECT count(*)::int AS count
                  FROM transcript_entries
                  WHERE user_id = ${legacyUserId}
                    AND turn_id = ${legacyInterruptedTurnId}
                    AND entry ->> '_tag' = 'InterruptedTurnTranscriptEntry'
                `
              ).toEqual([{ count: 1 }]);
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("appends stale interruption markers in bounded batches", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyOrphanTranscriptShape;
              yield* admin`
                WITH generated AS (
                  SELECT gen_random_uuid() AS entry_id, gen_random_uuid() AS turn_id, ordinal
                  FROM generate_series(1, 260) AS ordinal
                )
                INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
                SELECT
                  ${legacyUserId},
                  entry_id,
                  turn_id,
                  jsonb_build_object(
                    '_tag', 'UserTranscriptEntry',
                    'id', entry_id::text,
                    'turnId', turn_id::text,
                    'occurredAt', '2026-01-02T00:00:00Z',
                    'text', 'stale request ' || ordinal::text
                  )
                FROM generated
              `;

              yield* runPersistedSchemaReconciliation;
              expect(
                yield* admin<{ readonly count: number }>`
                  SELECT count(*)::int AS count
                  FROM transcript_entries
                  WHERE entry ->> '_tag' = 'InterruptedTurnTranscriptEntry'
                `
              ).toEqual([{ count: 260 }]);
              expect(
                yield* admin<{ readonly count: number }>`
                  SELECT count(*)::int AS count
                  FROM conversation_turns
                  WHERE state = 'Interrupted'
                `
              ).toEqual([{ count: 260 }]);
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("preserves an existing Interrupted marker without duplicating it", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyOrphanTranscriptShape;
              yield* admin`
                INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
                VALUES
                  (
                    ${legacyUserId}, ${legacyInterruptedUserEntryId}, ${legacyInterruptedTurnId},
                    jsonb_build_object(
                      '_tag', 'UserTranscriptEntry', 'id', ${legacyInterruptedUserEntryId}::text,
                      'turnId', ${legacyInterruptedTurnId}::text,
                      'occurredAt', '2026-01-02T00:00:00Z', 'text', 'legacy request'
                    )
                  ),
                  (
                    ${legacyUserId}, ${legacyInterruptedMarkerEntryId}, ${legacyInterruptedTurnId},
                    jsonb_build_object(
                      '_tag', 'InterruptedTurnTranscriptEntry',
                      'id', ${legacyInterruptedMarkerEntryId}::text,
                      'turnId', ${legacyInterruptedTurnId}::text,
                      'occurredAt', '2026-01-02T00:01:00Z'
                    )
                  )
              `;

              yield* runPersistedSchemaReconciliation;
              expect(
                yield* admin`
                  SELECT count(*)::int AS count
                  FROM transcript_entries
                  WHERE user_id = ${legacyUserId}
                    AND turn_id = ${legacyInterruptedTurnId}
                    AND entry ->> '_tag' = 'InterruptedTurnTranscriptEntry'
                `
              ).toEqual([{ count: 1 }]);
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("rejects future-dated orphan Transcript evidence", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyOrphanTranscriptShape;
              yield* admin`
                INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
                VALUES (
                  ${legacyUserId}, ${legacyFutureUserEntryId}, ${legacyFutureTurnId},
                  jsonb_build_object(
                    '_tag', 'UserTranscriptEntry', 'id', ${legacyFutureUserEntryId}::text,
                    'turnId', ${legacyFutureTurnId}::text,
                    'occurredAt', '2099-01-02T00:00:00Z', 'text', 'future request'
                  )
                )
              `;

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isFailure(migrationExit)).toBe(true);
              if (Exit.isFailure(migrationExit)) {
                expect(Cause.pretty(migrationExit.cause)).toContain(
                  "InvalidLegacyTranscriptEvidence"
                );
              }
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("rejects ambiguous completed evidence with multiple terminal replies", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyOrphanTranscriptShape;
              yield* insertLegacyOrphanTranscript;
              yield* admin`
                INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
                VALUES (
                  ${legacyUserId}, ${legacyDuplicateAssistantEntryId}, ${legacyOrphanTurnId},
                  jsonb_build_object(
                    '_tag', 'AssistantTranscriptEntry',
                    'id', ${legacyDuplicateAssistantEntryId}::text,
                    'turnId', ${legacyOrphanTurnId}::text,
                    'occurredAt', '2026-01-02T00:02:00Z',
                    'iteration', 2,
                    'text', 'ambiguous second response'
                  )
                )
              `;

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isFailure(migrationExit)).toBe(true);
              if (Exit.isFailure(migrationExit)) {
                expect(Cause.pretty(migrationExit.cause)).toContain(
                  "Orphan Transcript evidence does not identify a terminal Conversation Turn"
                );
              }
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("rejects completed evidence with an unmatched canonical tool call", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyOrphanTranscriptShape;
              yield* admin`
                INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
                VALUES
                  (
                    ${legacyUserId}, ${legacyOrphanUserEntryId}, ${legacyOrphanTurnId},
                    jsonb_build_object(
                      '_tag', 'UserTranscriptEntry', 'id', ${legacyOrphanUserEntryId}::text,
                      'turnId', ${legacyOrphanTurnId}::text,
                      'occurredAt', '2026-01-02T00:00:00Z', 'text', 'legacy request'
                    )
                  ),
                  (
                    ${legacyUserId}, ${legacyUnmatchedToolCallEntryId}, ${legacyOrphanTurnId},
                    jsonb_build_object(
                      '_tag', 'CanonicalToolCallEntry',
                      'id', ${legacyUnmatchedToolCallEntryId}::text,
                      'turnId', ${legacyOrphanTurnId}::text,
                      'occurredAt', '2026-01-02T00:00:30Z',
                      'iteration', 1,
                      'toolCallId', 'legacy-unmatched-call',
                      'operation', 'transactions.createTransaction',
                      'input', '{}'::jsonb
                    )
                  ),
                  (
                    ${legacyUserId}, ${legacyOrphanAssistantEntryId}, ${legacyOrphanTurnId},
                    jsonb_build_object(
                      '_tag', 'AssistantTranscriptEntry',
                      'id', ${legacyOrphanAssistantEntryId}::text,
                      'turnId', ${legacyOrphanTurnId}::text,
                      'occurredAt', '2026-01-02T00:01:00Z',
                      'iteration', 1, 'text', 'legacy response'
                    )
                  )
              `;

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isFailure(migrationExit)).toBe(true);
              if (Exit.isFailure(migrationExit)) {
                expect(Cause.pretty(migrationExit.cause)).toContain(
                  "Orphan Transcript evidence does not identify a terminal Conversation Turn"
                );
              }
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("rejects interleaved orphan Turn sequences", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyOrphanTranscriptShape;
              yield* admin`
                INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
                VALUES
                  (${legacyUserId}, ${legacyOrphanUserEntryId}, ${legacyOrphanTurnId},
                    jsonb_build_object('_tag', 'UserTranscriptEntry',
                      'id', ${legacyOrphanUserEntryId}::text, 'turnId', ${legacyOrphanTurnId}::text,
                      'occurredAt', '2026-01-02T00:00:00Z', 'text', 'first request')),
                  (${legacyUserId}, ${legacyInterleavedUserEntryId}, ${legacyInterleavedTurnId},
                    jsonb_build_object('_tag', 'UserTranscriptEntry',
                      'id', ${legacyInterleavedUserEntryId}::text,
                      'turnId', ${legacyInterleavedTurnId}::text,
                      'occurredAt', '2026-01-02T00:00:30Z', 'text', 'second request')),
                  (${legacyUserId}, ${legacyOrphanAssistantEntryId}, ${legacyOrphanTurnId},
                    jsonb_build_object('_tag', 'AssistantTranscriptEntry',
                      'id', ${legacyOrphanAssistantEntryId}::text,
                      'turnId', ${legacyOrphanTurnId}::text,
                      'occurredAt', '2026-01-02T00:01:00Z', 'iteration', 1,
                      'text', 'first response')),
                  (${legacyUserId}, ${legacyInterleavedAssistantEntryId}, ${legacyInterleavedTurnId},
                    jsonb_build_object('_tag', 'AssistantTranscriptEntry',
                      'id', ${legacyInterleavedAssistantEntryId}::text,
                      'turnId', ${legacyInterleavedTurnId}::text,
                      'occurredAt', '2026-01-02T00:01:30Z', 'iteration', 1,
                      'text', 'second response'))
              `;

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isFailure(migrationExit)).toBe(true);
              if (Exit.isFailure(migrationExit)) {
                expect(Cause.pretty(migrationExit.cause)).toContain(
                  "Orphan Transcript evidence does not identify a terminal Conversation Turn"
                );
              }
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("rejects an orphan interleaved with an already-attributed Turn", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyOrphanTranscriptShape;
              yield* admin`
                INSERT INTO conversation_continuity (user_id) VALUES (${legacyUserId})
              `;
              yield* admin`
                INSERT INTO hosted_agent_sessions (
                  user_id, id, consent_grant_id, disclosure_revision, disclosure_sha256,
                  policy_revision, policy_sha256, status, started_at, last_terminal_turn_at
                ) VALUES (
                  ${legacyUserId}, ${legacyExistingSessionId}, ${legacyOnboardingConsentId},
                  'onboarding-test',
                  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
                  'policy-test',
                  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
                  'idle-ended', '2026-01-02T00:00:20Z', '2026-01-02T00:00:40Z'
                )
              `;
              yield* admin`
                INSERT INTO conversation_turns (
                  user_id, id, state, started_at, terminal_at, failure_reason
                ) VALUES (
                  ${legacyUserId}, ${legacyInterleavedTurnId}, 'Completed',
                  '2026-01-02T00:00:20Z', '2026-01-02T00:00:40Z', NULL
                )
              `;
              yield* admin`
                INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
                VALUES
                  (${legacyUserId}, ${legacyOrphanUserEntryId}, ${legacyOrphanTurnId},
                    jsonb_build_object('_tag', 'UserTranscriptEntry',
                      'id', ${legacyOrphanUserEntryId}::text, 'turnId', ${legacyOrphanTurnId}::text,
                      'occurredAt', '2026-01-02T00:00:00Z', 'text', 'orphan request')),
                  (${legacyUserId}, ${legacyInterleavedAssistantEntryId}, ${legacyInterleavedTurnId},
                    jsonb_build_object('_tag', 'AssistantTranscriptEntry',
                      'id', ${legacyInterleavedAssistantEntryId}::text,
                      'turnId', ${legacyInterleavedTurnId}::text,
                      'occurredAt', '2026-01-02T00:00:40Z', 'iteration', 1,
                      'text', 'attributed response')),
                  (${legacyUserId}, ${legacyOrphanAssistantEntryId}, ${legacyOrphanTurnId},
                    jsonb_build_object('_tag', 'AssistantTranscriptEntry',
                      'id', ${legacyOrphanAssistantEntryId}::text,
                      'turnId', ${legacyOrphanTurnId}::text,
                      'occurredAt', '2026-01-02T00:01:00Z', 'iteration', 1,
                      'text', 'orphan response'))
              `;

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isFailure(migrationExit)).toBe(true);
              if (Exit.isFailure(migrationExit)) {
                expect(Cause.pretty(migrationExit.cause)).toContain(
                  "Orphan Transcript evidence does not identify a terminal Conversation Turn"
                );
              }
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("rejects an interrupted orphan with an unmatched tool result", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyOrphanTranscriptShape;
              yield* admin`
                INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
                VALUES
                  (${legacyUserId}, ${legacyInterruptedResultUserEntryId},
                    ${legacyInterruptedResultTurnId},
                    jsonb_build_object('_tag', 'UserTranscriptEntry',
                      'id', ${legacyInterruptedResultUserEntryId}::text,
                      'turnId', ${legacyInterruptedResultTurnId}::text,
                      'occurredAt', '2026-01-02T00:00:00Z', 'text', 'abandoned request')),
                  (${legacyUserId}, ${legacyUnmatchedToolResultEntryId},
                    ${legacyInterruptedResultTurnId},
                    jsonb_build_object('_tag', 'CanonicalToolResultEntry',
                      'id', ${legacyUnmatchedToolResultEntryId}::text,
                      'turnId', ${legacyInterruptedResultTurnId}::text,
                      'occurredAt', '2026-01-02T00:00:30Z', 'iteration', 1,
                      'toolCallId', 'missing-call',
                      'operation', 'transactions.createTransaction',
                      'outcome', jsonb_build_object('_tag', 'Succeeded', 'output', '{}'::jsonb)))
              `;

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isFailure(migrationExit)).toBe(true);
              if (Exit.isFailure(migrationExit)) {
                expect(Cause.pretty(migrationExit.cause)).toContain(
                  "Orphan Transcript evidence does not identify a terminal Conversation Turn"
                );
              }
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("rejects malformed orphan evidence without partial attribution", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyOrphanTranscriptShape;
              const canary = "private-malformed-transcript-content";
              yield* admin`
                INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
                VALUES (
                  ${legacyUserId}, ${legacyMalformedEntryId}, ${legacyMalformedTurnId},
                  jsonb_build_object(
                    '_tag', 'UnknownTranscriptEntry', 'id', ${legacyMalformedEntryId}::text,
                    'turnId', ${legacyMalformedTurnId}::text,
                    'occurredAt', '2026-01-02T00:00:00Z',
                    'text', ${canary}::text
                  )
                )
              `;

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isFailure(migrationExit)).toBe(true);
              if (Exit.isFailure(migrationExit)) {
                expect(Cause.pretty(migrationExit.cause)).not.toContain(canary);
              }
              expect(yield* admin`SELECT count(*)::int AS count FROM conversation_turns`).toEqual([
                { count: 0 },
              ]);
              expect(
                yield* admin`SELECT count(*)::int AS count FROM hosted_agent_sessions`
              ).toEqual([{ count: 0 }]);
              expect(
                yield* admin`
                  SELECT count(*)::int AS count FROM transcript_entries
                  WHERE entry ->> '_tag' = 'InterruptedTurnTranscriptEntry'
                `
              ).toEqual([{ count: 0 }]);
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("rejects ambiguous same-time onboarding grants", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyOrphanTranscriptShape;
              yield* insertLegacyOrphanTranscript;
              yield* admin`
                INSERT INTO consent_records (
                  id, subject_user_id, event_type, grant_type, service_market, locale,
                  disclosure_revision, disclosure_sha256, disclosure_text, policy_url,
                  policy_revision, policy_sha256, purposes, data_categories, duration,
                  revocation_method, disclosure_channel, disclosure_provider,
                  disclosure_provider_message_id, decision_channel, decision_provider,
                  decision_provider_message_id, occurred_at
                )
                SELECT
                  ${laterOnboardingConsentId}, subject_user_id, event_type, grant_type,
                  service_market, locale, 'onboarding-later', disclosure_sha256, disclosure_text,
                  policy_url, policy_revision, policy_sha256, purposes, data_categories, duration,
                  revocation_method, disclosure_channel, disclosure_provider,
                  'later-disclosure', decision_channel, decision_provider, 'later-decision',
                  '2026-01-01T00:00:00Z'
                FROM consent_records WHERE id = ${legacyOnboardingConsentId}
              `;

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isFailure(migrationExit)).toBe(true);
              if (Exit.isFailure(migrationExit)) {
                expect(Cause.pretty(migrationExit.cause)).toContain(
                  "Legacy hosted evidence spans distinct onboarding consent periods"
                );
              }
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("rejects a same-time revocation of the attributed onboarding grant", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyOrphanTranscriptShape;
              yield* insertLegacyOrphanTranscript;
              yield* admin`
                INSERT INTO consent_records (
                  id, subject_user_id, event_type, grant_type, revoked_grant_id,
                  service_market, locale, disclosure_revision, disclosure_sha256, disclosure_text,
                  policy_url, policy_revision, policy_sha256, purposes, data_categories, duration,
                  revocation_method, disclosure_channel, disclosure_provider,
                  disclosure_provider_message_id, decision_channel, decision_provider,
                  decision_provider_message_id, occurred_at
                )
                SELECT
                  ${onboardingRevocationId}, subject_user_id, 'revoked', NULL,
                  ${legacyOnboardingConsentId}, service_market, locale, disclosure_revision,
                  disclosure_sha256, disclosure_text, policy_url, policy_revision, policy_sha256,
                  purposes, data_categories, duration, revocation_method, disclosure_channel,
                  disclosure_provider, 'revocation-disclosure', decision_channel, decision_provider,
                  'revocation-decision', '2026-01-01T00:00:00Z'
                FROM consent_records WHERE id = ${legacyOnboardingConsentId}
              `;

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isFailure(migrationExit)).toBe(true);
              if (Exit.isFailure(migrationExit)) {
                expect(Cause.pretty(migrationExit.cause)).toContain(
                  "Legacy hosted evidence spans distinct onboarding consent periods"
                );
              }
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("rejects an orphaned Transcript without terminal evidence", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyOrphanTranscriptShape;
              yield* admin`
                INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
                VALUES (
                  ${legacyUserId},
                  ${legacyAmbiguousEntryId},
                  ${legacyAmbiguousTurnId},
                  jsonb_build_object(
                    '_tag', 'UserTranscriptEntry',
                    'id', ${legacyAmbiguousEntryId}::text,
                    'turnId', ${legacyAmbiguousTurnId}::text,
                    'occurredAt', CURRENT_TIMESTAMP,
                    'text', 'legacy incomplete request'
                  )
                )
              `;

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isFailure(migrationExit)).toBe(true);
              if (Exit.isFailure(migrationExit)) {
                expect(Cause.pretty(migrationExit.cause)).toContain(
                  "Orphan Transcript evidence does not identify a terminal Conversation Turn"
                );
              }
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );

    it.effect("attributes pre-session transcript and compaction evidence", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin
          .withTransaction(
            Effect.gen(function* () {
              yield* prepareLegacyTableShape;
              yield* insertLegacyConsent;
              yield* admin`INSERT INTO conversation_continuity (user_id) VALUES (${legacyUserId})`;
              yield* admin`ALTER TABLE conversation_turns DROP CONSTRAINT conversation_turns_user_id_session_id_fkey`;
              yield* admin`ALTER TABLE conversation_turns DROP COLUMN session_id`;
              yield* admin`ALTER TABLE compacted_conversations DROP CONSTRAINT compacted_conversations_user_id_session_id_fkey`;
              yield* admin`ALTER TABLE compacted_conversations DROP CONSTRAINT compacted_conversations_pkey`;
              yield* admin`ALTER TABLE compacted_conversations DROP COLUMN session_id`;
              yield* admin`ALTER TABLE compacted_conversations ADD CONSTRAINT compacted_conversations_pkey PRIMARY KEY (user_id)`;
              yield* admin`
                INSERT INTO conversation_turns (
                  user_id, id, state, started_at, terminal_at, failure_reason
                ) VALUES (
                  ${legacyUserId}, 'f1d1a000-0000-4000-8000-0000000008a5',
                  'Completed', '2026-01-02T00:00:00Z', '2026-01-02T00:01:00Z', NULL
                )
              `;
              yield* admin`
                INSERT INTO conversation_turns (
                  user_id, id, state, started_at, terminal_at, failure_reason
                ) VALUES (
                  ${legacyUserId}, 'f1d1a000-0000-4000-8000-0000000008a8',
                  'Pending', '2026-01-02T00:03:00Z', NULL, NULL
                )
              `;
              yield* admin`
                INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
                VALUES (
                  ${legacyUserId},
                  'f1d1a000-0000-4000-8000-0000000008a9',
                  'f1d1a000-0000-4000-8000-0000000008a5',
                  jsonb_build_object(
                    'id', 'f1d1a000-0000-4000-8000-0000000008a9',
                    'turnId', 'f1d1a000-0000-4000-8000-0000000008a5'
                  )
                )
              `;
              yield* admin`
                INSERT INTO compacted_conversations (
                  user_id, text, through_sequence, revision, updated_at
                ) VALUES (
                  ${legacyUserId}, 'legacy compacted evidence', 1, 1, '2026-01-02T00:02:00Z'
                )
              `;

              const migrationExit = yield* Effect.exit(runPersistedSchemaReconciliation);
              expect(Exit.isSuccess(migrationExit)).toBe(true);
              expect(
                yield* admin`
                  SELECT count(*)::int AS count
                  FROM conversation_turns
                  WHERE user_id = ${legacyUserId} AND session_id IS NOT NULL
                `
              ).toEqual([{ count: 2 }]);
              expect(
                yield* admin`
                  SELECT status
                  FROM hosted_agent_sessions
                  WHERE user_id = ${legacyUserId}
                `
              ).toEqual([{ status: "active" }]);
              expect(
                yield* admin`
                  SELECT count(*)::int AS count
                  FROM transcript_entries
                  WHERE user_id = ${legacyUserId}
                    AND turn_id = 'f1d1a000-0000-4000-8000-0000000008a5'
                `
              ).toEqual([{ count: 1 }]);
              expect(
                yield* admin`
                  SELECT count(*)::int AS count
                  FROM compacted_conversations
                  WHERE user_id = ${legacyUserId} AND session_id IS NOT NULL
                `
              ).toEqual([{ count: 1 }]);
              return yield* new RollbackMigrationFixture();
            })
          )
          .pipe(Effect.catchTag("RollbackMigrationFixture", () => Effect.succeed("rolled back")));

        expect(result).toBe("rolled back");
      })
    );
  }
);
