import { oauthClientIdleMs } from "../../oauth-agents/contract";
import { Effect, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";

const retentionAfterExpiryMs = 86400000;

const pageSize = 32,
  supportAdmissionHour = 3_600_000;

const settledPairings = `SELECT p.ordinal,p.expires_at_ms FROM browser_pairings p WHERE p.user_id IS NULL OR p.email_handoff IS NOT NULL OR EXISTS(SELECT 1 FROM provider_attempts a WHERE a.pairing_id=p.id AND (a.acknowledged=1 OR a.state='cancelled')) OR EXISTS(SELECT 1 FROM channel_approvals c WHERE c.pairing_id=p.id) OR EXISTS(SELECT 1 FROM support_handoffs s WHERE s.pairing_id=p.id)`;

const settledInvitations = `SELECT i.id,i.expires_at_ms FROM whatsapp_invitations i WHERE NOT EXISTS(SELECT 1 FROM provider_attempts a WHERE a.invitation=i.id AND a.state='bound' AND a.acknowledged=0)`;

export const drainBootstrapExpiry = Effect.fn(function* (now: number) {
  const sql = yield* SqliteClient;

  yield* Effect.forEach(
    ["email_capacity_slots", "media_capacity_slots"],
    (table) =>
      sql`UPDATE ${sql(table)} SET receipt=NULL,state=NULL,expires_at_ms=NULL WHERE slot IN (SELECT slot FROM ${sql(table)} WHERE receipt IS NOT NULL AND expires_at_ms<=${now} ORDER BY expires_at_ms LIMIT ${pageSize})`,
    { discard: true }
  );

  yield* sql`DELETE FROM session_routes WHERE token_digest IN(SELECT token_digest FROM session_routes WHERE hard_expires_at_ms<=${now} ORDER BY hard_expires_at_ms LIMIT ${pageSize})`;
  yield* sql`DELETE FROM recovery_rotations WHERE id IN(SELECT id FROM recovery_rotations WHERE state<>'reserved' AND expires_at_ms<=${now} ORDER BY expires_at_ms LIMIT ${pageSize})`;
  yield* sql.unsafe(
    `DELETE FROM browser_pairings WHERE ordinal IN(SELECT ordinal FROM (${settledPairings}) WHERE expires_at_ms<=? ORDER BY expires_at_ms LIMIT ?)`,
    [now, pageSize]
  );
  yield* sql.unsafe(
    `DELETE FROM whatsapp_invitations WHERE id IN(SELECT id FROM (${settledInvitations}) WHERE expires_at_ms<=? ORDER BY expires_at_ms LIMIT ?)`,
    [now - retentionAfterExpiryMs, pageSize]
  );
  yield* sql`DELETE FROM oauth_public_clients WHERE id IN(SELECT id FROM oauth_public_clients WHERE last_used_at_ms<=${now - oauthClientIdleMs} ORDER BY last_used_at_ms LIMIT ${pageSize})`;
  yield* sql`DELETE FROM oauth_review_requests WHERE id IN(SELECT id FROM oauth_review_requests WHERE expires_at_ms<=${now} ORDER BY expires_at_ms LIMIT ${pageSize})`;
  yield* sql`DELETE FROM oauth_routes WHERE rowid IN(SELECT rowid FROM oauth_routes WHERE expires_at_ms<=${now} ORDER BY expires_at_ms LIMIT ${pageSize})`;
  yield* sql`DELETE FROM oauth_leases WHERE expires_at_ms<=${now}`;
  yield* sql`DELETE FROM pat_source_windows WHERE source IN (SELECT source FROM pat_source_windows WHERE ends<=${now} ORDER BY ends LIMIT ${pageSize})`;
  yield* sql`DELETE FROM pat_routes WHERE short_id IN (SELECT short_id FROM pat_routes WHERE expires_at_ms<=${now} ORDER BY expires_at_ms LIMIT ${pageSize})`;
  yield* sql`DELETE FROM pat_bootstrap WHERE id IN (SELECT id FROM pat_bootstrap WHERE expires_at_ms<=${now} ORDER BY expires_at_ms LIMIT ${pageSize})`;
  yield* sql`DELETE FROM support_recovery_admissions WHERE id IN (SELECT id FROM support_recovery_admissions WHERE admitted_at_ms<=${now - supportAdmissionHour} ORDER BY admitted_at_ms LIMIT ${pageSize})`;
  yield* sql`DELETE FROM bootstrap_admissions WHERE id IN(SELECT id FROM bootstrap_admissions WHERE expires_at_ms<=${now} ORDER BY expires_at_ms LIMIT ${pageSize})`;
});

export const directoryDeadline = Effect.gen(function* () {
  const sql = yield* SqliteClient;

  const [row] = yield* sql.unsafe(
    `SELECT min(column1) AS deadline FROM (VALUES
      ((SELECT min(due_ms) FROM identity_replacement_checks)),
      ((SELECT min(expires_at_ms) FROM identity_replacements WHERE state<>'reserved')),
      ((SELECT min(erasure_check_ms) FROM fenced_provider_handoffs)),
      ((SELECT min(expires_at_ms) FROM email_capacity_slots WHERE receipt IS NOT NULL)),
      ((SELECT min(expires_at_ms) FROM media_capacity_slots WHERE receipt IS NOT NULL)),
      ((SELECT min(hard_expires_at_ms) FROM session_routes)),
      ((SELECT min(expires_at_ms) FROM recovery_rotations WHERE state<>'reserved')),
      ((SELECT min(virtual_at_ms) FROM unresolved_source_buckets)),
      ((SELECT min(last_used_at_ms)+? FROM oauth_public_clients)),
      ((SELECT min(admitted_at_ms)+? FROM support_recovery_admissions)),
      ((SELECT min(expires_at_ms) FROM oauth_routes)),
      ((SELECT min(expires_at_ms) FROM oauth_review_requests)),
      ((SELECT min(expires_at_ms) FROM oauth_leases)),
      ((SELECT min(ends) FROM pat_source_windows)),
      ((SELECT min(expires_at_ms) FROM pat_routes)),
      ((SELECT min(expires_at_ms) FROM pat_bootstrap)),
      ((SELECT min(expires_at_ms) FROM bootstrap_admissions)),
      ((SELECT min(expires_at_ms) FROM (${settledPairings}))),
      ((SELECT min(expires_at_ms)+? FROM (${settledInvitations})))
    )`,
    [oauthClientIdleMs, supportAdmissionHour, retentionAfterExpiryMs]
  );

  return yield* Schema.decodeUnknownEffect(
    Schema.Struct({ deadline: Schema.OptionFromNullOr(Schema.Int) })
  )(row);
});
