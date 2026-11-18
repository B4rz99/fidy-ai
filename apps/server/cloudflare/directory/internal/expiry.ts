import { Effect, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";

const retentionAfterExpiryMs = 86400000;
const pageSize = 32;
const settledPairings = `SELECT p.ordinal,p.expires_at_ms FROM browser_pairings p WHERE p.user_id IS NULL OR EXISTS(SELECT 1 FROM provider_attempts a WHERE a.pairing_id=p.id AND (a.acknowledged=1 OR a.state='cancelled')) OR EXISTS(SELECT 1 FROM channel_approvals c WHERE c.pairing_id=p.id)`;
const settledInvitations = `SELECT i.id,i.expires_at_ms FROM whatsapp_invitations i WHERE NOT EXISTS(SELECT 1 FROM provider_attempts a WHERE a.invitation=i.id AND a.state='bound' AND a.acknowledged=0)`;

/** Release expired comparison material while leaving every uncertain reservation fenced. */
export const drainBootstrapExpiry = Effect.fn(function* (now: number) {
  const sql = yield* SqliteClient;
  yield* sql.unsafe(
    `DELETE FROM browser_pairings WHERE ordinal IN(SELECT ordinal FROM (${settledPairings}) WHERE expires_at_ms<=? ORDER BY expires_at_ms LIMIT ?)`,
    [now, pageSize]
  );
  yield* sql.unsafe(
    `DELETE FROM whatsapp_invitations WHERE id IN(SELECT id FROM (${settledInvitations}) WHERE expires_at_ms<=? ORDER BY expires_at_ms LIMIT ?)`,
    [now - retentionAfterExpiryMs, pageSize]
  );
  yield* sql`DELETE FROM bootstrap_admissions WHERE id IN(SELECT id FROM bootstrap_admissions WHERE expires_at_ms<=${now} ORDER BY expires_at_ms LIMIT ${pageSize})`;
});

/** A pending owner check can schedule cleanup after the last browser or provider disconnects. */
export const directoryDeadline = Effect.gen(function* () {
  const sql = yield* SqliteClient;
  const [row] = yield* sql.unsafe(
    `SELECT min(deadline) AS deadline FROM(
    SELECT min(virtual_at_ms) AS deadline FROM unresolved_source_buckets UNION ALL
    SELECT min(expires_at_ms) FROM bootstrap_admissions UNION ALL
    SELECT min(expires_at_ms) FROM (${settledPairings}) UNION ALL
    SELECT min(expires_at_ms)+? FROM (${settledInvitations}))`,
    [retentionAfterExpiryMs]
  );
  return yield* Schema.decodeUnknownEffect(
    Schema.Struct({ deadline: Schema.OptionFromNullOr(Schema.Int) })
  )(row);
});
