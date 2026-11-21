import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Predicate } from "effect";

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

  const sampled = [...rows, ...writers];

  yield* Effect.forEach(
    sampled,
    (row) => {
      const count = Number(row.samples);

      if (count === 0) return Effect.void;

      return Effect.logInfo({
        component: "storage-uncertainty",
        operation: row.family,
        sampled: count,
        sampleLimited: count === uncertaintyLimit,
        oldestSampleAgeMs: Predicate.isNumber(row.oldest) ? Math.max(0, now - row.oldest) : null,
        message: `fidy.operational component=storage-uncertainty operation=${String(row.family)} state=unsettled severity=warning`,
      });
    },
    { discard: true }
  );

  const uncertain = sampled.reduce((total, row) => total + Number(row.samples), 0);

  return uncertain;
});
