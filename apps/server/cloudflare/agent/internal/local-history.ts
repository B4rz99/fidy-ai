import { Clock, Data, DateTime, Effect } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import type {
  CanonicalToolOutcome,
  CanonicalToolResultEntry,
} from "../../../src/core/agent/contract";
import { freeAllowanceLimits } from "../../../src/core/quotas/contract";
import { allowancePeriod } from "../../../src/core/quotas/operations";
import { activeProUserCondition } from "../../../src/shell/access-tier/operations";
import { loadsSavedHistory } from "./history-allowance";
import { type LocalTurn } from "./local-turn";

const Outcome = Data.taggedEnum<CanonicalToolOutcome>();

export const meterHistory = Effect.fn(function* (turn: LocalTurn, entry: CanonicalToolResultEntry) {
  if (!loadsSavedHistory(entry)) return entry.outcome;

  const sql = yield* SqliteClient,
    now = yield* Clock.currentTimeMillis;

  const period = allowancePeriod(DateTime.makeUnsafe(now)),
    start = period.startsAt.epochMilliseconds;

  const prior =
    yield* sql`SELECT 1 FROM commercial_allowance_consumptions WHERE user_id=${turn.user_id} AND allowance='hosted_history_turn' AND identity=${turn.id}`;

  if (prior.length === 1) return entry.outcome;
  const pro = activeProUserCondition({ userId: turn.user_id, nowEpochMs: now });

  const rows = yield* sql.unsafe(
    `INSERT INTO commercial_allowance_consumptions(user_id,allowance,identity,period_start_ms,accepted_at_ms,units)
    SELECT ?, 'hosted_history_turn', ?, ?, ?, units FROM (SELECT CASE WHEN ${pro.sql} THEN 0 ELSE 1 END AS units)
    WHERE units=0 OR (SELECT coalesce(sum(units),0) FROM commercial_allowance_consumptions WHERE user_id=? AND allowance='hosted_history_turn' AND period_start_ms=?)<? RETURNING identity`,
    [
      turn.user_id,
      turn.id,
      start,
      now,
      ...pro.params,
      turn.user_id,
      start,
      freeAllowanceLimits.hosted_history_turn,
    ]
  );

  return rows.length === 1
    ? entry.outcome
    : Outcome.CanonicalOperationFailed({
        failure: {
          error: {
            code: "quota_exhausted",
            allowance: "hosted_history_turn",
            resetsAt: DateTime.formatIso(period.resetsAt),
          },
          next: [],
        },
      });
});
