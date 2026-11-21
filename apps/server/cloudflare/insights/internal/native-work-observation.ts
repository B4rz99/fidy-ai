import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { InsightEventId } from "../../../src/core/insights/contract";
import { proactivityWorkflowId } from "./proactivity-workflow";
import { proactivityObservationLimit } from "../contract";

const job = Schema.Struct({
  kind: Schema.Literals(["weekly-summary", "weekly-question", "proactivity-delivery"]),
  user_id: UserId,
  id: InsightEventId,
  created: Schema.Int,
  deadline: Schema.Int,
});

export const nativePendingWork = Effect.fn(function* (flags: {
  weekly: boolean;
  category: boolean;
}) {
  const sql = yield* SqliteClient;

  const rows = yield* Schema.decodeUnknownEffect(Schema.Array(job))(
    yield* sql`SELECT * FROM (
    SELECT * FROM (SELECT observation_kind AS kind,user_id,id,created_ms AS created,deadline_ms AS deadline FROM reminder_deliveries WHERE ${Number(flags.category)}=1 AND observation_kind='proactivity-delivery' AND terminal_receipt=0 AND state IN('ready','claimed') ORDER BY created_ms,id LIMIT ${proactivityObservationLimit})
    UNION ALL SELECT * FROM (SELECT observation_kind,user_id,id,created_ms,deadline_ms FROM reminder_deliveries WHERE ${Number(flags.weekly)}=1 AND observation_kind='weekly-summary' AND terminal_receipt=0 AND state IN('ready','claimed') ORDER BY created_ms,id LIMIT ${proactivityObservationLimit})
    UNION ALL SELECT * FROM (SELECT 'weekly-question',user_id,id,created_ms,expires_ms FROM reminder_disclosures WHERE ${Number(flags.weekly)}=1 AND kind='weekly-summary' AND terminal_receipt=0 AND state IN('ready','claimed') ORDER BY created_ms,id LIMIT ${proactivityObservationLimit})
  ) ORDER BY created,id LIMIT ${proactivityObservationLimit}`
  );

  return yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const userId = row.user_id;

      const work =
        row.kind === "weekly-summary"
          ? { version: 1 as const, kind: row.kind, userId, insightEventId: row.id }
          : { version: 1 as const, kind: row.kind, userId, id: row.id };

      return {
        id: yield* proactivityWorkflowId(work),
        created: row.created,
        deadline: Option.some(row.deadline),
      };
    })
  );
});
