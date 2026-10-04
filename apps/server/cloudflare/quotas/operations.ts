import { DateTime, Effect, Option, Schema } from "effect";
import { allowanceMeter, allowancePeriod } from "../../src/core/quotas/operations";
import { newId } from "../secret-material/operations";
import {
  type AllowanceKind,
  type AllowanceMeter,
  type QuotaStatus,
  freeAllowanceLimits,
} from "../../src/core/quotas/contract";
import { activeProUserCondition } from "../../src/shell/access-tier/operations";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import type { ConsumptionInput } from "./contract";

const CountRow = Schema.Struct({
  pro: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  forwarded_email: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  media_submission: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  hosted_history_turn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  canonical_call: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** Guards the subject and inserts at most one unit with the owner transition. D1 enforces capacity under races. */
const consumptionStatements = (
  input: ConsumptionInput,
  mode: "required" | "if-available"
): ReadonlyArray<D1PreparedStatement> => {
  const period = allowancePeriod(DateTime.makeUnsafe(input.current));
  const pro = activeProUserCondition({ userId: input.userId, nowEpochMs: input.current });
  const assertionId = `${input.allowance}:${input.identity}`;
  const availability =
    mode === "required"
      ? { sql: "1", params: [] }
      : {
          sql: `(${pro.sql}) OR (SELECT coalesce(sum(units),0) FROM commercial_allowance_consumptions WHERE user_id = ? AND allowance = ? AND period_start_ms = ?) < ?`,
          params: [
            ...pro.params,
            input.userId,
            input.allowance,
            DateTime.toEpochMillis(period.startsAt),
            freeAllowanceLimits[input.allowance],
          ],
        };
  return [
    input.db
      .prepare(`INSERT INTO commercial_allowance_assertions(id,valid)
      VALUES (?, EXISTS (SELECT 1 FROM (${input.authority.sql}) WHERE userId = ?))`)
      .bind(assertionId, ...input.authority.params, input.userId),
    input.db
      .prepare(`INSERT INTO commercial_allowance_consumptions(user_id,allowance,identity,period_start_ms,accepted_at_ms,units)
      SELECT ?,?,?,?,?,CASE WHEN ${pro.sql} THEN 0 ELSE 1 END WHERE ${availability.sql}
      ON CONFLICT(user_id,allowance,identity) DO NOTHING`)
      .bind(
        input.userId,
        input.allowance,
        input.identity,
        DateTime.toEpochMillis(period.startsAt),
        input.current,
        ...pro.params,
        ...availability.params
      ),
    input.db.prepare("DELETE FROM commercial_allowance_assertions WHERE id = ?").bind(assertionId),
  ];
};

/** Required publication fails atomically if this Free unit cannot be admitted. */
export const prepareConsumption = (input: ConsumptionInput): ReadonlyArray<D1PreparedStatement> =>
  consumptionStatements(input, "required");

/** Email may branch to bounded deferral in the same D1 batch if no processing unit is available. */
export const prepareAvailableConsumption = (
  input: ConsumptionInput
): ReadonlyArray<D1PreparedStatement> => consumptionStatements(input, "if-available");

/** Owner-scoped commit proof for peers joining their transition to this allowance admission. */
export const allowanceConsumptionProof = ({
  userId,
  allowance,
  identity,
}: Readonly<{ userId: string; allowance: AllowanceKind; identity: string }>): OwnedStatement => ({
  sql: "SELECT 1 FROM commercial_allowance_consumptions WHERE user_id = ? AND allowance = ? AND identity = ?",
  params: [userId, allowance, identity],
});

/** Explicit-User current-period count for an owner-held read projection, never inferred from Audit or receipts. */
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

/** Classifies only closed D1 constraint provenance; all other failures are unavailable. */
export const quotaFailure = (failure: unknown): "exhausted" | "authority" | "unavailable" => {
  const text = String(failure);
  if (/commercial_quota_exhausted: SQLITE_CONSTRAINT/u.test(text)) return "exhausted";
  if (/commercial_authority_required/u.test(text)) return "authority";
  return "unavailable";
};

/** Observes a bounded consumption projection. Caller must guard and audit disclosure before releasing it. */
export const quotaStatusStatement = (
  input: Readonly<{ db: D1Database; userId: string; current: number }>
): D1PreparedStatement => {
  const pro = activeProUserCondition({ userId: input.userId, nowEpochMs: input.current });
  const period = allowancePeriod(DateTime.makeUnsafe(input.current));
  return input.db
    .prepare(`SELECT ${pro.sql} AS pro,
    coalesce(sum(CASE WHEN allowance = 'forwarded_email' THEN units ELSE 0 END),0) AS forwarded_email,
    coalesce(sum(CASE WHEN allowance = 'media_submission' THEN units ELSE 0 END),0) AS media_submission,
    coalesce(sum(CASE WHEN allowance = 'hosted_history_turn' THEN units ELSE 0 END),0) AS hosted_history_turn,
    coalesce(sum(CASE WHEN allowance = 'canonical_call' THEN units ELSE 0 END),0) AS canonical_call
    FROM commercial_allowance_consumptions WHERE user_id = ? AND period_start_ms = ?`)
    .bind(...pro.params, input.userId, DateTime.toEpochMillis(period.startsAt));
};

/** Snapshot standing only while the exact supplied User-scoped authority is live in this same D1 batch. */
export const prepareAuthorizedQuotaRead = ({
  db,
  userId,
  current,
  authority,
}: Readonly<{
  db: D1Database;
  userId: string;
  current: number;
  authority: Readonly<{ sql: string; params: ReadonlyArray<string | number | Uint8Array> }>;
}>): ReadonlyArray<D1PreparedStatement> => {
  const id = newId();
  return [
    db
      .prepare(
        "INSERT INTO commercial_allowance_assertions VALUES (?,CASE WHEN EXISTS (SELECT 1 FROM (" +
          authority.sql +
          ") WHERE userId = ?) THEN 1 ELSE 0 END)"
      )
      .bind(id, ...authority.params, userId),
    quotaStatusStatement({ db, userId, current }),
    db.prepare("DELETE FROM commercial_allowance_assertions WHERE id = ?").bind(id),
  ];
};

/** Decodes the owner projection; a malformed meter is unavailable, never zero consumption. */
export const decodeQuotaStatus = (
  input: Readonly<{ row: unknown; current: number }>
): Option.Option<QuotaStatus> =>
  Option.map(Schema.decodeUnknownOption(CountRow)(input.row), (counts) => {
    const accessTier = counts.pro === 1 ? "pro" : "free";
    const meter = (allowance: keyof Omit<typeof counts, "pro">): AllowanceMeter =>
      allowanceMeter({
        allowance,
        accessTier,
        consumed: counts[allowance],
        now: DateTime.makeUnsafe(input.current),
      });
    return {
      accessTier,
      forwardedEmails: meter("forwarded_email"),
      mediaSubmissions: meter("media_submission"),
      hostedHistoryTurns: meter("hosted_history_turn"),
      canonicalCalls: meter("canonical_call"),
    };
  });

/** Reads only one explicit User for guarded peer composition; storage/decode failure remains absent authority. */
export const readQuotaStatus = (
  input: Readonly<{ db: D1Database; userId: string; current: number }>
): Effect.Effect<Option.Option<QuotaStatus>> =>
  Effect.tryPromise({
    try: () => quotaStatusStatement(input).first(),
    catch: () => undefined,
  }).pipe(
    Effect.map((row) => decodeQuotaStatus({ row, current: input.current })),
    Effect.orElseSucceed(() => Option.none())
  );
