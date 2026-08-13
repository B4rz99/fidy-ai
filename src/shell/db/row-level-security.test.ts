import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { UserId } from "~/core/identity/reference";
import { TransactionId } from "~/core/transactions/model";
import { ApiHarness } from "~/shell/testing/api-harness";
import { MigrationSqlClient, assertRuntimeAuthority } from "./client";
import { userTableNames } from "./user-tables";
import { withUserTransaction } from "./user-transaction";

const owner = UserId.make("f1d1a000-0000-4000-8000-0000000000c1");
const stranger = UserId.make("f1d1a000-0000-4000-8000-0000000000d2");
const ownerTransactionId = TransactionId.make("f1d1a000-0000-4000-8000-0000000000e3");

const UserContextRow = Schema.Struct({ userId: UserId });

type RlsPolicyCoverageRow = {
  readonly tableName: string;
  readonly rowSecurity: boolean;
  readonly forceRowSecurity: boolean;
  readonly policyCount: number;
};

type PublicTableRow = { readonly tableName: string };
type UnexpectedInsertRow = { readonly tableName: string };

const observeContext = Effect.fn("observeRlsContext")(function* (userId: UserId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* withUserTransaction(
    userId,
    Effect.gen(function* () {
      yield* sql`SELECT pg_sleep(0.02)`;
      const setting = yield* SqlSchema.findOne({
        Request: Schema.Void,
        Result: UserContextRow,
        execute: () => sql`
          SELECT current_setting('fidy.user_id', true) AS "userId"
        `,
      })(undefined);
      const rows = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: UserContextRow,
        execute: () => sql`
          SELECT user_id AS "userId" FROM transactions ORDER BY user_id
        `,
      })(undefined);
      return { setting: setting.userId, rows };
    })
  );
});

const seedRows = Effect.gen(function* () {
  const admin = yield* MigrationSqlClient;
  yield* admin`
    INSERT INTO users (
      id, service_market, locale, time_zone, paid_tier,
      trial_started_at, trial_ends_at, created_at
    ) VALUES
      (
        ${owner}, 'CO', 'es-CO', 'America/Bogota', 'free',
        '2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z', '2026-01-01T00:00:00Z'
      ),
      (
        ${stranger}, 'CO', 'es-CO', 'America/Bogota', 'free',
        '2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z', '2026-01-01T00:00:00Z'
      )
    ON CONFLICT (id) DO NOTHING
  `;
  yield* admin`DELETE FROM transactions WHERE id = ${ownerTransactionId}`;
  yield* admin`
    INSERT INTO transactions (
      id, user_id, amount, currency, counterparty, direction, occurred_at, category_id
    ) VALUES (
      ${ownerTransactionId}, ${owner}, 25000, 'COP', 'Registro privado', 'outflow',
      '2026-07-20T12:30:00Z', '10000000-0000-4000-8000-000000000016'
    )
  `;
});

const policyOwner = UserId.make("f1d1a000-0000-4000-8000-0000000001a1");
const policyStranger = UserId.make("f1d1a000-0000-4000-8000-0000000001b2");
const policyInsertVictim = UserId.make("f1d1a000-0000-4000-8000-0000000003a1");
const policyContinuityVictim = UserId.make("f1d1a000-0000-4000-8000-0000000003a2");
const policyForgedUser = UserId.make("f1d1a000-0000-4000-8000-0000000003b2");
const policyTransactionId = TransactionId.make("f1d1a000-0000-4000-8000-0000000001c3");

const seedEveryPolicyShape = Effect.gen(function* () {
  const admin = yield* MigrationSqlClient;
  yield* admin`
    INSERT INTO users (
      id, service_market, locale, time_zone, paid_tier,
      trial_started_at, trial_ends_at, created_at
    ) VALUES
      (
        ${policyOwner}, 'CO', 'es-CO', 'America/Bogota', 'free',
        '2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z', '2026-01-01T00:00:00Z'
      ),
      (
        ${policyStranger}, 'CO', 'es-CO', 'America/Bogota', 'free',
        '2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z', '2026-01-01T00:00:00Z'
      ),
      (
        ${policyInsertVictim}, 'CO', 'es-CO', 'America/Bogota', 'free',
        '2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z', '2026-01-01T00:00:00Z'
      ),
      (
        ${policyContinuityVictim}, 'CO', 'es-CO', 'America/Bogota', 'free',
        '2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z', '2026-01-01T00:00:00Z'
      )
  `;
  yield* admin`
    INSERT INTO agent_confirmation_consumptions (user_id, digest, consumed_at)
    VALUES (${policyOwner}, ${"a".repeat(64)}, '2026-01-01T00:00:00Z')
  `;
  yield* admin`
    INSERT INTO whatsapp_identities (
      business_portfolio_id, business_scoped_user_id, phone_number, user_id, verified_at
    ) VALUES (
      'portfolio-test', 'CO.573001112233', '+573001112233', ${policyOwner}, '2026-01-01T00:00:00Z'
    )
  `;
  yield* admin`
    INSERT INTO agent_tokens (
      id, user_id, short_id, token_hash, scopes, idle_expires_at, created_at
    ) VALUES (
      'f1d1a000-0000-4000-8000-0000000001d4', ${policyOwner}, 'rlsprobe',
      repeat('a', 64), ARRAY['read'], '2026-04-01T00:00:00Z', '2026-01-01T00:00:00Z'
    )
  `;
  yield* admin`
    INSERT INTO consent_records (
      id, subject_user_id, event_type, grant_type, service_market, locale,
      disclosure_revision, disclosure_sha256, disclosure_text, policy_url,
      policy_revision, policy_sha256, purposes, data_categories, duration,
      revocation_method, disclosure_channel, disclosure_provider,
      disclosure_provider_message_id, decision_channel, decision_provider,
      decision_provider_message_id, occurred_at
    ) VALUES (
      'f1d1a000-0000-4000-8000-0000000001d5', ${policyOwner}, 'granted', 'onboarding',
      'CO', 'es-CO', 'policy-probe', repeat('a', 64), 'policy probe',
      'https://fidyapp.com/politica', 'policy-probe', repeat('b', 64),
      ARRAY['service'], ARRAY['identity'], 'until revoked', 'chat',
      'whatsapp', 'probe', 'policy-disclosure', 'whatsapp', 'probe',
      'policy-decision', '2026-01-01T00:00:00Z'
    )
  `;
  yield* admin`
    INSERT INTO transactions (
      id, user_id, amount, currency, counterparty, direction, occurred_at, category_id
    ) VALUES (
      ${policyTransactionId}, ${policyOwner}, 1, 'COP', 'policy probe', 'outflow',
      '2026-01-01T00:00:00Z', '10000000-0000-4000-8000-000000000016'
    )
  `;
  yield* admin`
    INSERT INTO statement_submissions (
      id, user_id, idempotency_key, content_hash, source_format, file_content, status,
      service_market, locale, time_zone, parser_revision
    ) VALUES (
      'f1d1a000-0000-4000-8000-0000000006a1', ${policyOwner},
      'f1d1a000-0000-4000-8000-0000000006a2', repeat('c', 64), 'csv', '\\x61',
      'queued', 'CO', 'es-CO', 'America/Bogota', 'policy-probe'
    )
  `;
  yield* admin`
    INSERT INTO statement_backfill_entitlements (user_id) VALUES (${policyOwner})
  `;
  yield* admin`
    INSERT INTO statement_format_profiles (
      user_id, fingerprint, extractor_revision, mapping, created_at
    ) VALUES (${policyOwner}, ${"d".repeat(64)}, 'policy-probe', '{}'::jsonb, '2026-01-01T00:00:00Z')
  `;
  yield* admin`
    INSERT INTO needs_review_items (
      id, user_id, submission_id, record_number, reason, service_market, locale, time_zone,
      source_format, source_channel, parser_revision, extractor_revision, original_evidence, issues,
      status
    ) VALUES (
      'f1d1a000-0000-4000-8000-0000000006a3', ${policyOwner},
      'f1d1a000-0000-4000-8000-0000000006a1', 1, 'missing-amount', 'CO', 'es-CO',
      'America/Bogota', 'csv', 'statement-upload', 'policy-probe', 'policy-probe',
      '{}'::jsonb, '[]'::jsonb, 'pending'
    )
  `;
  yield* admin`
    INSERT INTO audit_log_entries (id, user_id, token_id, operation, outcome, occurred_at)
    VALUES (
      'f1d1a000-0000-4000-8000-0000000001e5', ${policyOwner},
      'f1d1a000-0000-4000-8000-0000000001d4', 'probe.read', 'succeeded',
      '2026-01-01T00:00:00Z'
    )
  `;
  yield* admin`
    INSERT INTO keyword_rules (id, user_id, keyword, normalized_keyword, category_id)
    VALUES (
      'f1d1a000-0000-4000-8000-0000000001f6', ${policyOwner}, 'probe', 'probe',
      '10000000-0000-4000-8000-000000000016'
    )
  `;
  yield* admin`
    INSERT INTO source_attestations (
      id, transaction_id, kind, service_market, locale, time_zone, interpretation_revision
    ) VALUES (
      'f1d1a000-0000-4000-8000-0000000002a1', ${policyTransactionId}, 'manual',
      'CO', 'es-CO', 'America/Bogota', 'policy-probe'
    )
  `;
  yield* admin`
    INSERT INTO insight_events (
      id, user_id, kind, schedule_id, schedule_version, service_market, locale, time_zone,
      scheduled_at
    ) VALUES (
      'f1d1a000-0000-4000-8000-0000000002b2', ${policyOwner}, 'weekly-summary',
      'f1d1a000-0000-4000-8000-0000000002c3', 1, 'CO', 'es-CO', 'America/Bogota',
      '2026-01-01T00:00:00Z'
    )
  `;
  yield* admin`
    INSERT INTO insight_money_groups (insight_event_id, currency, inflow_amount, outflow_amount)
    VALUES ('f1d1a000-0000-4000-8000-0000000002b2', 'COP', 1, 0)
  `;
  yield* admin`
    INSERT INTO insight_delivery_attempts (
      id, insight_event_id, sent_at, channel, provider, provider_message_id
    ) VALUES (
      'f1d1a000-0000-4000-8000-0000000002d4',
      'f1d1a000-0000-4000-8000-0000000002b2', '2026-01-01T00:00:00Z',
      'whatsapp', 'probe', 'policy-probe'
    )
  `;
  yield* admin`
    INSERT INTO dashboards (user_id, document)
    VALUES (${policyOwner}, '{"title":"policy probe"}'::jsonb)
  `;
  yield* admin`
    INSERT INTO memories (user_id, id, text, created_at, updated_at)
    VALUES (
      ${policyOwner}, 'f1d1a000-0000-4000-8000-0000000002a2', 'policy memory',
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    )
  `;
  yield* admin`
    INSERT INTO conversation_continuity (user_id, revision)
    VALUES (${policyOwner}, 1), (${policyInsertVictim}, 0)
  `;
  yield* admin`
    INSERT INTO conversation_turns (user_id, id, state, started_at)
    VALUES (
      ${policyOwner}, 'f1d1a000-0000-4000-8000-0000000002f6',
      'Pending', '2026-01-01T00:00:00Z'
    )
  `;
  yield* admin`
    INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
    VALUES (
      ${policyOwner}, 'f1d1a000-0000-4000-8000-0000000002e5',
      'f1d1a000-0000-4000-8000-0000000002f6',
      '{"id":"f1d1a000-0000-4000-8000-0000000002e5","turnId":"f1d1a000-0000-4000-8000-0000000002f6"}'::jsonb
    )
  `;
  yield* admin`
    INSERT INTO whatsapp_identity_change_evidence(
      provider_message_id, user_id, business_portfolio_id,
      previous_business_scoped_user_id, replacement_business_scoped_user_id,
      occurred_at, applied
    ) VALUES (
      'policy-identity-change', ${policyOwner}, 'portfolio-test',
      'CO.573001110000', 'CO.573001112233', '2026-01-01T00:00:00Z', true
    )
  `;
  yield* admin`
    INSERT INTO whatsapp_message_evidence(
      provider_message_id, user_id, direction, delivery_key, occurred_at
    ) VALUES ('policy-whatsapp-evidence', ${policyOwner}, 'inbound', 'policy-delivery', '2026-01-01T00:00:00Z')
  `;
  yield* admin`
    INSERT INTO whatsapp_turn_claims(id, user_id, status, claim_expires_at)
    VALUES ('f1d1a000-0000-4000-8000-0000000005a1', ${policyOwner}, 'claimed', '2026-01-01T00:01:00Z')
  `;
  yield* admin`
    INSERT INTO whatsapp_inbound_jobs(
      id, user_id, message_evidence_id, content, occurred_at, enqueued_at, debounce_until, claim_id
    ) VALUES (
      'f1d1a000-0000-4000-8000-0000000005b2', ${policyOwner},
      (SELECT id FROM whatsapp_message_evidence WHERE provider_message_id = 'policy-whatsapp-evidence'),
      'policy content', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:02Z', 'f1d1a000-0000-4000-8000-0000000005a1'
    )
  `;
  yield* admin`
    INSERT INTO compacted_conversations(user_id, text, through_sequence, revision, updated_at)
    VALUES (${policyOwner}, 'policy compacted conversation', 1, 1, '2026-01-01T00:00:00Z')
  `;
  yield* admin`
    INSERT INTO whatsapp_conversation_windows(
      user_id, identity_verified_at, business_phone_number_id,
      business_portfolio_id, business_scoped_user_id, window_open_until
    ) VALUES (
      ${policyOwner}, '2026-01-01T00:00:00Z', 'policy-business',
      'portfolio-test', 'CO.573001112233', '2026-01-02T00:00:00Z'
    )
  `;
});

type PolicyProbe = {
  readonly tableName: (typeof userTableNames)[number];
  readonly stableColumn: string;
  readonly ownerPredicate: string;
};

const policyProbes: ReadonlyArray<PolicyProbe> = [
  {
    tableName: "agent_confirmation_consumptions",
    stableColumn: "consumed_at",
    ownerPredicate: `user_id = '${policyOwner}' AND digest = '${"a".repeat(64)}'`,
  },
  {
    tableName: "agent_tokens",
    stableColumn: "short_id",
    ownerPredicate: "id = 'f1d1a000-0000-4000-8000-0000000001d4'",
  },
  {
    tableName: "audit_log_entries",
    stableColumn: "operation",
    ownerPredicate: "id = 'f1d1a000-0000-4000-8000-0000000001e5'",
  },
  {
    tableName: "dashboards",
    stableColumn: "document",
    ownerPredicate: `user_id = '${policyOwner}'`,
  },
  {
    tableName: "conversation_continuity",
    stableColumn: "revision",
    ownerPredicate: `user_id = '${policyOwner}'`,
  },
  {
    tableName: "compacted_conversations",
    stableColumn: "revision",
    ownerPredicate: `user_id = '${policyOwner}'`,
  },
  {
    tableName: "conversation_turns",
    stableColumn: "state",
    ownerPredicate: "id = 'f1d1a000-0000-4000-8000-0000000002f6'",
  },
  {
    tableName: "insight_delivery_attempts",
    stableColumn: "provider",
    ownerPredicate: "id = 'f1d1a000-0000-4000-8000-0000000002d4'",
  },
  {
    tableName: "insight_events",
    stableColumn: "lifecycle_state",
    ownerPredicate: "id = 'f1d1a000-0000-4000-8000-0000000002b2'",
  },
  {
    tableName: "insight_money_groups",
    stableColumn: "inflow_amount",
    ownerPredicate: "insight_event_id = 'f1d1a000-0000-4000-8000-0000000002b2'",
  },
  {
    tableName: "keyword_rules",
    stableColumn: "keyword",
    ownerPredicate: "id = 'f1d1a000-0000-4000-8000-0000000001f6'",
  },
  {
    tableName: "needs_review_items",
    stableColumn: "reason",
    ownerPredicate: "id = 'f1d1a000-0000-4000-8000-0000000006a3'",
  },
  {
    tableName: "source_attestations",
    stableColumn: "time_zone",
    ownerPredicate: "id = 'f1d1a000-0000-4000-8000-0000000002a1'",
  },
  {
    tableName: "statement_backfill_entitlements",
    stableColumn: "consumed_at",
    ownerPredicate: `user_id = '${policyOwner}'`,
  },
  {
    tableName: "statement_format_profiles",
    stableColumn: "extractor_revision",
    ownerPredicate: `user_id = '${policyOwner}' AND fingerprint = '${"d".repeat(64)}'`,
  },
  {
    tableName: "statement_submissions",
    stableColumn: "content_hash",
    ownerPredicate: "id = 'f1d1a000-0000-4000-8000-0000000006a1'",
  },
  {
    tableName: "transactions",
    stableColumn: "counterparty",
    ownerPredicate: `id = '${policyTransactionId}'`,
  },
  {
    tableName: "transcript_entries",
    stableColumn: "entry",
    ownerPredicate: "entry_id = 'f1d1a000-0000-4000-8000-0000000002e5'",
  },
  { tableName: "users", stableColumn: "locale", ownerPredicate: `id = '${policyOwner}'` },
  {
    tableName: "whatsapp_identities",
    stableColumn: "verified_at",
    ownerPredicate: "phone_number = '+573001112233'",
  },

  {
    tableName: "whatsapp_message_evidence",
    stableColumn: "occurred_at",
    ownerPredicate: "provider_message_id = 'policy-whatsapp-evidence'",
  },
  {
    tableName: "whatsapp_turn_claims",
    stableColumn: "claim_expires_at",
    ownerPredicate: "id = 'f1d1a000-0000-4000-8000-0000000005a1'",
  },
  {
    tableName: "whatsapp_inbound_jobs",
    stableColumn: "debounce_until",
    ownerPredicate: "id = 'f1d1a000-0000-4000-8000-0000000005b2'",
  },
  {
    tableName: "whatsapp_conversation_windows",
    stableColumn: "window_open_until",
    ownerPredicate: `user_id = '${policyOwner}'`,
  },
];

const probeDeniedMutations = Effect.fn("probeDeniedRlsMutations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.forEach(policyProbes, ({ tableName, stableColumn, ownerPredicate }) =>
    Effect.gen(function* () {
      const read = yield* sql.unsafe(
        `SELECT 1 AS visible FROM ${tableName} WHERE ${ownerPredicate}`
      );
      const update = yield* sql.unsafe(
        `UPDATE ${tableName} SET ${stableColumn} = ${stableColumn} WHERE ${ownerPredicate} RETURNING 1 AS touched`
      );
      const deleted = yield* sql.unsafe(
        `DELETE FROM ${tableName} WHERE ${ownerPredicate} RETURNING 1 AS touched`
      );
      return { tableName, read, update, deleted };
    })
  );
});

const deniedInsertProbes = (sql: SqlClient.SqlClient) =>
  [
    {
      tableName: "memories",
      insert: sql`
        INSERT INTO memories (id, user_id, text, created_at, updated_at)
        VALUES (
          'f1d1a000-0000-4000-8000-0000000002b3', ${policyOwner}, 'denied memory',
          '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'
        )
      `,
    },
    {
      tableName: "agent_confirmation_consumptions",
      insert: sql`
        INSERT INTO agent_confirmation_consumptions (user_id, digest, consumed_at)
        VALUES (${policyOwner}, ${"b".repeat(64)}, '2026-01-02T00:00:00Z')
      `,
    },
    {
      tableName: "users",
      insert: sql`
      INSERT INTO users (
        id, service_market, locale, time_zone, paid_tier,
        trial_started_at, trial_ends_at, created_at
      ) VALUES (
        ${policyForgedUser}, 'CO', 'es-CO', 'America/Bogota', 'free',
        '2026-01-02T00:00:00Z', '2026-01-09T00:00:00Z', '2026-01-02T00:00:00Z'
      )
    `,
    },
    {
      tableName: "whatsapp_identities",
      insert: sql`
      INSERT INTO whatsapp_identities (
        business_portfolio_id, business_scoped_user_id, phone_number, user_id, verified_at
      ) VALUES (
        'portfolio-test', 'CO.573009998877', '+573009998877', ${policyOwner}, '2026-01-02T00:00:00Z'
      )
    `,
    },
    {
      tableName: "whatsapp_message_evidence",
      insert: sql`
      INSERT INTO whatsapp_message_evidence(
        provider_message_id, user_id, direction, delivery_key, occurred_at
      ) VALUES ('denied-whatsapp-evidence', ${policyOwner}, 'inbound', 'denied-delivery', '2026-01-02T00:00:00Z')
    `,
    },
    {
      tableName: "whatsapp_turn_claims",
      insert: sql`
      INSERT INTO whatsapp_turn_claims(id, user_id, status, claim_expires_at)
      VALUES ('f1d1a000-0000-4000-8000-0000000005c3', ${policyOwner}, 'claimed', '2026-01-02T00:01:00Z')
    `,
    },
    {
      tableName: "whatsapp_inbound_jobs",
      insert: sql`
      INSERT INTO whatsapp_inbound_jobs(
        id, user_id, message_evidence_id, content, occurred_at, enqueued_at, debounce_until
      ) VALUES (
        'f1d1a000-0000-4000-8000-0000000005d4', ${policyOwner}, 1, 'denied content',
        '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-02T00:00:02Z'
      )
    `,
    },
    {
      tableName: "whatsapp_conversation_windows",
      insert: sql`
      INSERT INTO whatsapp_conversation_windows(
        user_id, identity_verified_at, business_phone_number_id,
        business_portfolio_id, business_scoped_user_id, window_open_until
      ) VALUES (
        ${policyOwner}, '2026-01-01T00:00:00Z', 'denied-business',
        'portfolio-test', 'CO.573001112233', '2026-01-02T00:00:00Z'
      )
    `,
    },
    {
      tableName: "agent_tokens",
      insert: sql`
      INSERT INTO agent_tokens (
        id, user_id, short_id, token_hash, scopes, idle_expires_at, created_at
      ) VALUES (
        'f1d1a000-0000-4000-8000-0000000003c3', ${policyOwner}, 'insertprobe',
        repeat('b', 64), ARRAY['read'], '2026-04-02T00:00:00Z', '2026-01-02T00:00:00Z'
      )
    `,
    },
    {
      tableName: "consent_records",
      insert: sql`
      INSERT INTO consent_records (
        id, subject_user_id, event_type, grant_type, service_market, locale,
        disclosure_revision, disclosure_sha256, disclosure_text, policy_url,
        policy_revision, policy_sha256, purposes, data_categories, duration,
        revocation_method, disclosure_channel, disclosure_provider,
        disclosure_provider_message_id, decision_channel, decision_provider,
        decision_provider_message_id, occurred_at
      ) VALUES (
        'f1d1a000-0000-4000-8000-0000000003b2', ${policyOwner}, 'granted', 'onboarding',
        'CO', 'es-CO', 'denied-insert', repeat('a', 64), 'denied insert',
        'https://fidyapp.com/politica', 'denied-insert', repeat('b', 64),
        ARRAY['service'], ARRAY['identity'], 'until revoked', 'chat',
        'whatsapp', 'probe', 'denied-disclosure', 'whatsapp', 'probe',
        'denied-decision', '2026-01-02T00:00:00Z'
      )
    `,
    },
    {
      tableName: "transactions",
      insert: sql`
      INSERT INTO transactions (
        id, user_id, amount, currency, counterparty, direction, occurred_at, category_id
      ) VALUES (
        'f1d1a000-0000-4000-8000-0000000003d4', ${policyOwner}, 1, 'COP',
        'denied insert', 'outflow', '2026-01-02T00:00:00Z',
        '10000000-0000-4000-8000-000000000016'
      )
    `,
    },
    {
      tableName: "audit_log_entries",
      insert: sql`
      INSERT INTO audit_log_entries (id, user_id, token_id, operation, outcome, occurred_at)
      VALUES (
        'f1d1a000-0000-4000-8000-0000000003e5', ${policyOwner},
        'f1d1a000-0000-4000-8000-0000000001d4', 'probe.insert', 'succeeded',
        '2026-01-02T00:00:00Z'
      )
    `,
    },
    {
      tableName: "keyword_rules",
      insert: sql`
      INSERT INTO keyword_rules (id, user_id, keyword, normalized_keyword, category_id)
      VALUES (
        'f1d1a000-0000-4000-8000-0000000003f6', ${policyOwner}, 'insert', 'insert',
        '10000000-0000-4000-8000-000000000016'
      )
    `,
    },
    {
      tableName: "source_attestations",
      insert: sql`
      INSERT INTO source_attestations (
        id, transaction_id, kind, service_market, locale, time_zone,
        interpretation_revision
      ) VALUES (
        'f1d1a000-0000-4000-8000-0000000004a1', ${policyTransactionId}, 'manual',
        'CO', 'es-CO', 'America/Bogota', 'denied-insert'
      )
    `,
    },
    {
      tableName: "insight_events",
      insert: sql`
      INSERT INTO insight_events (
        id, user_id, kind, schedule_id, schedule_version, service_market, locale, time_zone,
        scheduled_at
      ) VALUES (
        'f1d1a000-0000-4000-8000-0000000004b2', ${policyOwner}, 'weekly-summary',
        'f1d1a000-0000-4000-8000-0000000004c3', 1, 'CO', 'es-CO', 'America/Bogota',
        '2026-01-02T00:00:00Z'
      )
    `,
    },
    {
      tableName: "insight_money_groups",
      insert: sql`
      INSERT INTO insight_money_groups (
        insight_event_id, currency, inflow_amount, outflow_amount
      ) VALUES ('f1d1a000-0000-4000-8000-0000000002b2', 'USD', 1, 0)
    `,
    },
    {
      tableName: "insight_delivery_attempts",
      insert: sql`
      INSERT INTO insight_delivery_attempts (
        id, insight_event_id, sent_at, channel, provider, provider_message_id
      ) VALUES (
        'f1d1a000-0000-4000-8000-0000000004d4',
        'f1d1a000-0000-4000-8000-0000000002b2', '2026-01-02T00:00:00Z',
        'whatsapp', 'denied', 'denied-insert'
      )
    `,
    },
    {
      tableName: "dashboards",
      insert: sql`
      INSERT INTO dashboards (user_id, document)
      VALUES (${policyInsertVictim}, '{"title":"denied insert"}'::jsonb)
    `,
    },
    {
      tableName: "conversation_continuity",
      insert: sql`
        INSERT INTO conversation_continuity (user_id, revision)
        VALUES (${policyContinuityVictim}, 0)
      `,
    },
    {
      tableName: "conversation_turns",
      insert: sql`
        INSERT INTO conversation_turns (user_id, id, state, started_at)
        VALUES (
          ${policyOwner}, 'f1d1a000-0000-4000-8000-0000000004f7',
          'Pending', '2026-01-02T00:00:00Z'
        )
      `,
    },
    {
      tableName: "transcript_entries",
      insert: sql`
      INSERT INTO transcript_entries (user_id, entry_id, turn_id, entry)
      VALUES (
        ${policyOwner}, 'f1d1a000-0000-4000-8000-0000000004e5',
        'f1d1a000-0000-4000-8000-0000000004f6',
        '{"id":"f1d1a000-0000-4000-8000-0000000004e5","turnId":"f1d1a000-0000-4000-8000-0000000004f6"}'::jsonb
      )
    `,
    },
  ] as const;

const probeDeniedInserts = Effect.fn("probeDeniedRlsInserts")(function* (
  userId: Option.Option<UserId>
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.forEach(deniedInsertProbes(sql), ({ tableName, insert }) =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        Option.isNone(userId) ? insert : withUserTransaction(userId.value, insert)
      );
      return { tableName, result };
    })
  );
});

layer(ApiHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "PostgreSQL User isolation",
  (it) => {
    it.effect(
      "starts only with a restricted runtime role and complete forced policy coverage",
      () =>
        Effect.gen(function* () {
          yield* assertRuntimeAuthority;
          const admin = yield* MigrationSqlClient;
          const covered = yield* admin<RlsPolicyCoverageRow>`
          SELECT relation.relname AS "tableName",
            relation.relrowsecurity AS "rowSecurity",
            relation.relforcerowsecurity AS "forceRowSecurity",
            count(policy.policyname)::integer AS "policyCount"
          FROM pg_catalog.pg_class AS relation
          INNER JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          LEFT JOIN pg_catalog.pg_policies AS policy
            ON policy.schemaname = namespace.nspname AND policy.tablename = relation.relname
          WHERE namespace.nspname = 'public'
            AND relation.relname = ANY(${userTableNames})
          GROUP BY relation.relname, relation.relrowsecurity, relation.relforcerowsecurity
          ORDER BY relation.relname
        `;

          expect(covered.map((row) => row.tableName)).toEqual(userTableNames);
          expect(
            covered.every((row) => row.rowSecurity && row.forceRowSecurity && row.policyCount === 1)
          ).toBe(true);

          const publicTables = yield* admin<PublicTableRow>`
            SELECT tablename AS "tableName"
            FROM pg_catalog.pg_tables
            WHERE schemaname = 'public'
            ORDER BY tablename
          `;
          expect(publicTables.map((row) => row.tableName)).toEqual(
            [
              ...userTableNames,
              "categories",
              "effect_sql_migrations",
              "pending_consent_exchanges",
              "whatsapp_consent_disclosure_delivery_attempts",
              "whatsapp_ingress_budget_receipts",
              "whatsapp_ingress_budgets",
              "whatsapp_inbound_receipts",
            ].sort()
          );
        })
    );

    it.effect("keeps WhatsApp gateway-owned rows inaccessible to ordinary runtime SQL", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        expect(
          (yield* Effect.exit(sql`SELECT * FROM whatsapp_identity_change_evidence`))._tag
        ).toBe("Failure");
        expect((yield* Effect.exit(sql`SELECT * FROM whatsapp_ingress_budgets`))._tag).toBe(
          "Failure"
        );
        expect((yield* Effect.exit(sql`SELECT * FROM whatsapp_ingress_budget_receipts`))._tag).toBe(
          "Failure"
        );
        expect((yield* Effect.exit(sql`SELECT * FROM whatsapp_inbound_receipts`))._tag).toBe(
          "Failure"
        );
        expect(
          (yield* Effect.exit(
            sql`INSERT INTO whatsapp_ingress_budgets(budget_key, window_started_at, accepted_count)
                  VALUES ('forged', now(), 1)`
          ))._tag
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            sql`INSERT INTO whatsapp_inbound_receipts(
                    provider_message_id, delivery_key, status, claim_id,
                    claim_expires_at, first_received_at
                  ) VALUES ('forged', 'forged', 'processing',
                    'f1d1a000-0000-4000-8000-000000000001', now(), now())`
          ))._tag
        ).toBe("Failure");
      })
    );

    it.effect("fails closed when the runtime connection uses the migration authority", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* Effect.exit(
          assertRuntimeAuthority.pipe(Effect.provideService(SqlClient.SqlClient, admin))
        );

        expect(result._tag).toBe("Failure");
      })
    );

    it.effect("fails closed when the runtime role can assume the gateway authority", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        yield* Effect.gen(function* () {
          yield* admin`GRANT fidy_gateway TO fidy_runtime`;
          expect((yield* Effect.exit(assertRuntimeAuthority))._tag).toBe("Failure");
        }).pipe(Effect.ensuring(admin`REVOKE fidy_gateway FROM fidy_runtime`.pipe(Effect.orDie)));
      })
    );

    it.effect("fails closed when an owner authenticates and switches to the runtime role", () =>
      Effect.gen(function* () {
        const admin = yield* MigrationSqlClient;
        const result = yield* admin.withTransaction(
          Effect.gen(function* () {
            yield* admin`SET LOCAL ROLE fidy_runtime`;
            return yield* Effect.exit(
              assertRuntimeAuthority.pipe(Effect.provideService(SqlClient.SqlClient, admin))
            );
          })
        );
        expect(result._tag).toBe("Failure");
      })
    );

    it.effect("denies every CRUD shape without context and under another User context", () =>
      Effect.gen(function* () {
        yield* seedRows;
        const sql = yield* SqlClient.SqlClient;

        expect(yield* sql`SELECT id FROM transactions WHERE id = ${ownerTransactionId}`).toEqual(
          []
        );
        expect(
          yield* sql`UPDATE transactions SET counterparty = 'sin contexto' WHERE id = ${ownerTransactionId}`
        ).toEqual([]);
        expect(yield* sql`DELETE FROM transactions WHERE id = ${ownerTransactionId}`).toEqual([]);

        const missingInsert = yield* Effect.exit(sql`
          INSERT INTO transactions (
            user_id, amount, currency, counterparty, direction, occurred_at, category_id
          ) VALUES (
            ${owner}, 1, 'COP', 'sin contexto', 'outflow', now(),
            '10000000-0000-4000-8000-000000000016'
          )
        `);
        expect(missingInsert._tag).toBe("Failure");

        const wrongRead = yield* withUserTransaction(
          stranger,
          sql`SELECT id FROM transactions WHERE id = ${ownerTransactionId}`
        );
        const wrongUpdate = yield* withUserTransaction(
          stranger,
          sql`UPDATE transactions SET counterparty = 'intruso' WHERE id = ${ownerTransactionId}`
        );
        const wrongDelete = yield* withUserTransaction(
          stranger,
          sql`DELETE FROM transactions WHERE id = ${ownerTransactionId}`
        );
        const wrongInsert = yield* Effect.exit(
          withUserTransaction(
            stranger,
            sql`
              INSERT INTO transactions (
                user_id, amount, currency, counterparty, direction, occurred_at, category_id
              ) VALUES (
                ${owner}, 1, 'COP', 'intruso', 'outflow', now(),
                '10000000-0000-4000-8000-000000000016'
              )
            `
          )
        );

        expect(wrongRead).toEqual([]);
        expect(wrongUpdate).toEqual([]);
        expect(wrongDelete).toEqual([]);
        expect(wrongInsert._tag).toBe("Failure");
        expect(
          yield* withUserTransaction(
            owner,
            sql`SELECT counterparty FROM transactions WHERE id = ${ownerTransactionId}`
          )
        ).toEqual([{ counterparty: "Registro privado" }]);
      })
    );

    it.effect("denies reads and mutations for every User-owned policy shape", () =>
      Effect.gen(function* () {
        yield* seedEveryPolicyShape;
        const sql = yield* SqlClient.SqlClient;

        const withoutContext = yield* probeDeniedMutations();
        const underStranger = yield* withUserTransaction(policyStranger, probeDeniedMutations());
        for (const result of [...withoutContext, ...underStranger]) {
          expect(result.read, result.tableName).toEqual([]);
          expect(result.update, result.tableName).toEqual([]);
          expect(result.deleted, result.tableName).toEqual([]);
        }

        expect(
          Exit.isSuccess(
            yield* Effect.exit(
              withUserTransaction(
                policyOwner,
                sql`UPDATE memories SET text = text WHERE id = 'f1d1a000-0000-4000-8000-0000000002a2'`
              )
            )
          )
        ).toBe(true);
        expect(
          Exit.isSuccess(
            yield* Effect.exit(
              withUserTransaction(
                policyOwner,
                sql`DELETE FROM memories WHERE id = 'f1d1a000-0000-4000-8000-0000000002a2'`
              )
            )
          )
        ).toBe(true);
        expect(yield* sql`SELECT id FROM consent_records`).toEqual([]);
        expect(
          yield* withUserTransaction(
            policyOwner,
            sql`SELECT id FROM consent_records WHERE subject_user_id = ${policyOwner}`
          )
        ).toHaveLength(1);
        expect(
          yield* withUserTransaction(
            policyStranger,
            sql`SELECT id FROM consent_records WHERE subject_user_id = ${policyOwner}`
          )
        ).toEqual([]);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              withUserTransaction(
                policyOwner,
                sql`UPDATE consent_records SET occurred_at = occurred_at WHERE subject_user_id = ${policyOwner}`
              )
            )
          )
        ).toBe(true);
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              withUserTransaction(
                policyOwner,
                sql`DELETE FROM consent_records WHERE subject_user_id = ${policyOwner}`
              )
            )
          )
        ).toBe(true);

        const missingContextInserts = yield* probeDeniedInserts(Option.none());
        const strangerInserts = yield* probeDeniedInserts(Option.some(policyStranger));
        for (const { tableName, result } of [...missingContextInserts, ...strangerInserts]) {
          expect(result._tag, tableName).toBe("Failure");
        }
        expect(missingContextInserts.map(({ tableName }) => tableName).sort()).toEqual(
          deniedInsertProbes(sql)
            .map(({ tableName }) => tableName)
            .sort()
        );

        const admin = yield* MigrationSqlClient;
        const unexpectedInserts = yield* admin<UnexpectedInsertRow>`
          SELECT 'memories' AS "tableName" WHERE EXISTS (
            SELECT 1 FROM memories WHERE id = 'f1d1a000-0000-4000-8000-0000000002b3'
          )
          UNION ALL SELECT 'users' WHERE EXISTS (
            SELECT 1 FROM users WHERE id = ${policyForgedUser}
          )
          UNION ALL SELECT 'whatsapp_identities' WHERE EXISTS (
            SELECT 1 FROM whatsapp_identities WHERE phone_number = '+573009998877'
          )
          UNION ALL SELECT 'agent_tokens' WHERE EXISTS (
            SELECT 1 FROM agent_tokens WHERE id = 'f1d1a000-0000-4000-8000-0000000003c3'
          )
          UNION ALL SELECT 'consent_records' WHERE EXISTS (
            SELECT 1 FROM consent_records WHERE id = 'f1d1a000-0000-4000-8000-0000000003b2'
          )
          UNION ALL SELECT 'transactions' WHERE EXISTS (
            SELECT 1 FROM transactions WHERE id = 'f1d1a000-0000-4000-8000-0000000003d4'
          )
          UNION ALL SELECT 'audit_log_entries' WHERE EXISTS (
            SELECT 1 FROM audit_log_entries WHERE id = 'f1d1a000-0000-4000-8000-0000000003e5'
          )
          UNION ALL SELECT 'keyword_rules' WHERE EXISTS (
            SELECT 1 FROM keyword_rules WHERE id = 'f1d1a000-0000-4000-8000-0000000003f6'
          )
          UNION ALL SELECT 'source_attestations' WHERE EXISTS (
            SELECT 1 FROM source_attestations WHERE id = 'f1d1a000-0000-4000-8000-0000000004a1'
          )
          UNION ALL SELECT 'insight_events' WHERE EXISTS (
            SELECT 1 FROM insight_events WHERE id = 'f1d1a000-0000-4000-8000-0000000004b2'
          )
          UNION ALL SELECT 'insight_money_groups' WHERE EXISTS (
            SELECT 1 FROM insight_money_groups
            WHERE insight_event_id = 'f1d1a000-0000-4000-8000-0000000002b2'
              AND currency = 'USD'
          )
          UNION ALL SELECT 'insight_delivery_attempts' WHERE EXISTS (
            SELECT 1 FROM insight_delivery_attempts
            WHERE id = 'f1d1a000-0000-4000-8000-0000000004d4'
          )
          UNION ALL SELECT 'dashboards' WHERE EXISTS (
            SELECT 1 FROM dashboards WHERE user_id = ${policyInsertVictim}
          )
          UNION ALL SELECT 'conversation_continuity' WHERE EXISTS (
            SELECT 1 FROM conversation_continuity WHERE user_id = ${policyContinuityVictim}
          )
          UNION ALL SELECT 'conversation_turns' WHERE EXISTS (
            SELECT 1 FROM conversation_turns
            WHERE id = 'f1d1a000-0000-4000-8000-0000000004f7'
          )
          UNION ALL SELECT 'transcript_entries' WHERE EXISTS (
            SELECT 1 FROM transcript_entries
            WHERE entry_id = 'f1d1a000-0000-4000-8000-0000000004e5'
          )
        `;
        expect(unexpectedInserts).toEqual([]);

        expect(
          yield* withUserTransaction(
            policyOwner,
            sql`SELECT id FROM transactions WHERE id = ${policyTransactionId}`
          )
        ).toEqual([{ id: policyTransactionId }]);
      })
    );

    it.effect("resets pooled context and keeps concurrently interleaved Users separate", () =>
      Effect.gen(function* () {
        yield* seedRows;
        const sql = yield* SqlClient.SqlClient;
        const observed = yield* Effect.all([observeContext(owner), observeContext(stranger)], {
          concurrency: "unbounded",
        });

        expect(observed).toEqual([
          { setting: owner, rows: [{ userId: owner }] },
          { setting: stranger, rows: [] },
        ]);
        expect(
          yield* sql`SELECT current_setting('fidy.user_id', true) AS "userId", id FROM transactions`
        ).toEqual([]);
      })
    );
  }
);
