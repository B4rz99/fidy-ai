import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect } from "effect";

const uncertaintyLimit = 33;

export const inspectUncertainty = Effect.gen(function* () {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* sql`
    SELECT 'login-email' family,count(*) samples,min(requested_at_ms) oldest FROM (SELECT requested_at_ms FROM login_email_proofs WHERE state IN ('sending','ambiguous') ORDER BY requested_at_ms LIMIT 33)
    UNION ALL SELECT 'replacement-email',count(*),min(created_at_ms) FROM (SELECT created_at_ms FROM email_replacements WHERE state IN ('sending','ambiguous') ORDER BY created_at_ms LIMIT 33)
    UNION ALL SELECT 'billing',count(*),min(collection_sent_at_ms) FROM (SELECT collection_sent_at_ms FROM billing_attempts WHERE collection_state='sent' AND status='pending' ORDER BY collection_sent_at_ms LIMIT 33)
    UNION ALL SELECT 'whatsapp',count(*),min(started_ms) FROM (SELECT started_ms FROM whatsapp_deliveries WHERE state IN ('sending','accepted','ambiguous') ORDER BY started_ms LIMIT 33)
`;
  const writers =
    yield* sql`SELECT 'sample' family,count(*) samples,min(decided_at_ms) oldest FROM (SELECT d.decided_at_ms FROM (SELECT sample_id FROM ingest_sample_reservations LIMIT 33) r JOIN ingest_sample_decisions d ON d.sample_id=r.sample_id)
    UNION ALL SELECT 'original-write',count(*),NULL FROM (SELECT nonce FROM original_writers LIMIT 33)`;
  let uncertain = 0;
  for (const row of [...rows, ...writers]) {
    const count = Number(row.samples);
    uncertain += count;
    if (count > 0) {
      yield* Effect.logInfo({
        component: "storage-uncertainty",
        operation: row.family,
        sampled: count,
        sampleLimited: count === uncertaintyLimit,
        oldestSampleAgeMs: typeof row.oldest === "number" ? Math.max(0, now - row.oldest) : null,
        message: `fidy.operational component=storage-uncertainty operation=${String(row.family)} state=unsettled severity=warning`,
      });
    }
  }
  return uncertain;
});
