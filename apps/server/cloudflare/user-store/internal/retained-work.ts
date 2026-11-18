import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect } from "effect";
import type { StorageCommand } from "../../storage-operations/contract";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";

const uncertaintyLimit = 33;
const canContinueWork = Effect.fnUntraced(function* (
  family: string,
  work: Readonly<Record<string, unknown>>,
  now: number
) {
  return family === "sample"
    ? work.outcome === "approved" || work.outcome === "removing"
    : work.outcome === "awaiting_delivery" &&
        typeof work.deadlineMs === "number" &&
        work.deadlineMs > now &&
        (yield* (yield* SqliteClient)`SELECT 1 FROM erasure_requests LIMIT 1`).length === 0;
});
export const retainedWork = Effect.fn(function* (
  command: StorageCommand,
  storage: DurableObjectStorage,
  deadline: number
) {
  if (command.owner !== "user" || !("family" in command)) {
    return new Response(null, { status: 409 });
  }
  const sql = yield* SqliteClient;
  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const [work] =
        command.family === "sample"
          ? yield* sql`SELECT phase AS outcome,due_ms AS dueMs FROM ingest_sample_decisions WHERE user_id=${command.userId} AND candidate_id=${command.operationId}`
          : yield* sql`SELECT p.state AS outcome,p.offer_at_ms AS dueMs,p.expires_at_ms AS deadlineMs FROM login_email_proofs p JOIN browser_handoffs h ON h.pairing_id=p.pairing_id WHERE h.user_id=${command.userId} AND p.work_id=${command.operationId}`;
      if (work === undefined) return new Response(null, { status: 404 });
      if (command.action === "inspect-work") return Response.json(work);
      const now = yield* Clock.currentTimeMillis;
      const due = typeof work.dueMs === "number" && work.dueMs <= now;
      const eligible = yield* canContinueWork(command.family, work, now);
      if (now >= deadline || !due || !eligible) return new Response(null, { status: 409 });
      yield* preserveStoreAlarm(storage, now);
      return Response.json(work, { status: 202 });
    })
  );
});

/** Indexed oldest samples count unresolved claims separately from scheduled work. Counts saturate at 33. */
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
    UNION ALL SELECT 'original-write',count(*),min(nullif(opened_ms,0)) FROM (SELECT opened_ms FROM original_writers ORDER BY opened_ms LIMIT 33)`;
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
