import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect } from "effect";
import type { UserId } from "../../../src/core/identity/contract";

export const hostedStatementSelection = ({
  turn,
  user,
  current,
}: {
  turn: string;
  user: UserId;
  current: number;
}): OwnedStatement => ({
  sql: `SELECT s.id FROM statement_submissions s
    JOIN hosted_turns t ON t.id=? AND t.user_id=s.user_id AND t.session_id=s.hosted_session_id AND t.state='running' AND t.deadline_ms>?
    JOIN hosted_whatsapp_inbound a ON a.turn_id=t.id AND a.user_id=s.user_id
    JOIN hosted_whatsapp_inbound o ON o.turn_id=s.hosted_turn_id AND o.user_id=a.user_id AND o.portfolio=a.portfolio AND o.bsuid=a.bsuid AND o.endpoint=a.endpoint
    WHERE s.user_id=? AND s.hosted_abandoned_at_ms IS NULL AND s.hosted_expires_at_ms>?`,
  params: [turn, current, user, current],
});

export const hostedStatements = Effect.fn(function* (turn: string, user: UserId, current: number) {
  const scope = hostedStatementSelection({ turn, user, current });

  return (yield* SqliteClient).unsafe(scope.sql, scope.params);
});
