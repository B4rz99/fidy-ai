import { DateTime, Option, Schema } from "effect";
import { allowancePeriod, projectQuotaStatus } from "../../src/core/quotas/operations";
import { type AllowanceKind, type QuotaStatus } from "../../src/core/quotas/contract";
import { activeProForUserSelection } from "../../src/shell/access-tier/operations";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";

const CountRow = Schema.Struct({
  pro: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  forwarded_email: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  media_submission: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  hosted_history_turn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  canonical_call: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const allowanceConsumptionProof = ({
  userId,
  allowance,
  identity,
}: Readonly<{ userId: string; allowance: AllowanceKind; identity: string }>): OwnedStatement => ({
  sql: "SELECT 1 FROM commercial_allowance_consumptions WHERE user_id = ? AND allowance = ? AND identity = ?",
  params: [userId, allowance, identity],
});

export const allowanceConsumptionCount = ({
  userId,
  allowance,
  current,
}: Readonly<{ userId: string; allowance: AllowanceKind; current: number }>): OwnedStatement => ({
  sql: "SELECT coalesce(sum(units),0) FROM commercial_allowance_consumptions WHERE user_id = ? AND allowance = ? AND period_start_ms = ?",
  params: [
    userId,
    allowance,
    DateTime.toEpochMillis(allowancePeriod(DateTime.makeUnsafe(current)).startsAt),
  ],
});

export const quotaStatusSelection = (
  input: Readonly<{ users: OwnedStatement; current: number }>
): OwnedStatement => {
  const pro = activeProForUserSelection({ users: input.users, nowEpochMs: input.current });
  const period = allowancePeriod(DateTime.makeUnsafe(input.current));

  return {
    sql: `SELECT ${pro.sql} AS pro,
    coalesce(sum(CASE WHEN allowance = 'forwarded_email' THEN units ELSE 0 END),0) AS forwarded_email,
    coalesce(sum(CASE WHEN allowance = 'media_submission' THEN units ELSE 0 END),0) AS media_submission,
    coalesce(sum(CASE WHEN allowance = 'hosted_history_turn' THEN units ELSE 0 END),0) AS hosted_history_turn,
    coalesce(sum(CASE WHEN allowance = 'canonical_call' THEN units ELSE 0 END),0) AS canonical_call
    FROM commercial_allowance_consumptions WHERE user_id IN (${input.users.sql})
    AND allowance IN ('forwarded_email','media_submission','hosted_history_turn','canonical_call')
    AND period_start_ms = ?`,
    params: [...pro.params, ...input.users.params, DateTime.toEpochMillis(period.startsAt)],
  };
};

export const decodeQuotaStatus = (
  input: Readonly<{ row: unknown; current: number }>
): Option.Option<QuotaStatus> =>
  Option.map(Schema.decodeUnknownOption(CountRow)(input.row), (counts) =>
    projectQuotaStatus({
      accessTier: counts.pro === 1 ? "pro" : "free",
      consumed: counts,
      now: DateTime.makeUnsafe(input.current),
    })
  );
