import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect } from "effect";
import type { UserId } from "../../../src/core/identity/contract";

/** The verified recipient can continue only documents admitted into this still-live Hosted Agent Session. */
export const hostedStatements = Effect.fn(function* (turn: string, user: UserId, current: number) {
  const sql = yield* SqliteClient;
  return sql`SELECT s.id FROM statement_submissions s
    JOIN hosted_turns t ON t.id=${turn} AND t.user_id=s.user_id AND t.session_id=s.hosted_session_id AND t.state='running' AND t.deadline_ms>${current}
    JOIN hosted_whatsapp_inbound a ON a.turn_id=t.id AND a.user_id=s.user_id
    JOIN hosted_whatsapp_inbound o ON o.turn_id=s.hosted_turn_id AND o.user_id=a.user_id AND o.portfolio=a.portfolio AND o.bsuid=a.bsuid AND o.endpoint=a.endpoint
    WHERE s.user_id=${user} AND s.hosted_abandoned_at_ms IS NULL AND s.hosted_expires_at_ms>${current}`;
});
