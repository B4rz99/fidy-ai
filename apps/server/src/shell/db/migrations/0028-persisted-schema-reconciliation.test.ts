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
        id, user_id, short_id, token_hash, scopes,
        last_used_at, idle_expires_at, revoked_at, created_at, kind, expires_at
      ) VALUES (
        ${fixture.tokenId}, ${legacyUserId}, ${fixture.shortId},
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
      decision_channel, decision_provider, decision_provider_message_id, occurred_at
    ) VALUES (
      ${legacyOnboardingConsentId}, ${legacyUserId}, 'granted', 'onboarding',
      NULL, NULL, 'CO', 'es-CO', 'onboarding-test',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'test disclosure',
      'https://example.test/policy', 'policy-test',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      ARRAY['test']::text[], ARRAY['test']::text[], 'test duration', 'test revocation',
      'whatsapp', 'kapso', 'legacy-disclosure', 'whatsapp', 'kapso', 'legacy-decision',
      '2026-01-01T00:00:00Z'
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
      decision_channel, decision_provider, decision_provider_message_id, occurred_at
    ) VALUES (
      ${legacyPatConsentId}, ${legacyUserId}, 'granted', 'pat', NULL, NULL, ${legacyPatTokenId},
      'CO', 'es-CO', 'pat-test',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'test disclosure',
      'https://example.test/policy', 'policy-test',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      ARRAY['test']::text[], ARRAY['test']::text[], 'test duration', 'test revocation',
      'whatsapp', 'kapso', 'legacy-pat-disclosure', 'whatsapp', 'kapso', 'legacy-pat-decision',
      '2026-01-01T12:00:00Z'
    )
  `;
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

              const migrationExit = yield* Effect.exit(
                persistedSchemaReconciliation.pipe(
                  Effect.provideService(SqlClient.SqlClient, admin)
                )
              );
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

              const migrationExit = yield* Effect.exit(
                persistedSchemaReconciliation.pipe(
                  Effect.provideService(SqlClient.SqlClient, admin)
                )
              );
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

              const migrationExit = yield* Effect.exit(
                persistedSchemaReconciliation.pipe(
                  Effect.provideService(SqlClient.SqlClient, admin)
                )
              );
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

              const migrationExit = yield* Effect.exit(
                persistedSchemaReconciliation.pipe(
                  Effect.provideService(SqlClient.SqlClient, admin)
                )
              );
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

              const migrationExit = yield* Effect.exit(
                persistedSchemaReconciliation.pipe(
                  Effect.provideService(SqlClient.SqlClient, admin)
                )
              );
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

              const migrationExit = yield* Effect.exit(
                persistedSchemaReconciliation.pipe(
                  Effect.provideService(SqlClient.SqlClient, admin)
                )
              );
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
