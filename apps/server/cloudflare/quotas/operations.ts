import {
  preparePredicateAssertion,
  preparePredicateCheck,
} from "../../src/shell/sql-assertions/operations";
import { prepareAuthorizedAuditCall, recordedPATCallProof } from "../../src/shell/audit/operations";
import {
  livePATAuthority,
  recordAuditedPATUseFromAuthority,
} from "../../src/shell/tokens/operations";
import { type QueryCaller, callerAuthority, isPATCaller } from "../canonical-work/operations";
import { newId } from "../secret-material/operations";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { allowancePeriod, projectQuotaStatus } from "../../src/core/quotas/operations";
import {
  type AllowanceKind,
  QuotaStatus,
  freeAllowanceLimits,
} from "../../src/core/quotas/contract";
import {
  activeProForUserSelection,
  activeProUserCondition,
} from "../../src/shell/access-tier/operations";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import type { ConsumptionInput } from "./contract";

const CountRow = Schema.Struct({
  pro: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  forwarded_email: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  media_submission: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  hosted_history_turn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  canonical_call: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const consumptionStatements = (
  input: ConsumptionInput,
  mode: "required" | "if-available"
): ReadonlyArray<D1PreparedStatement> => {
  const period = allowancePeriod(DateTime.makeUnsafe(input.current));
  const pro = activeProUserCondition({ userId: input.userId, nowEpochMs: input.current });
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
    preparePredicateAssertion({
      db: input.db,
      scope: "commercial_allowance",
      predicate: {
        sql: `SELECT 1 FROM (${input.authority.sql}) WHERE userId = ?`,
        params: [...input.authority.params, input.userId],
      },
    }),
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
  ];
};

export const prepareConsumption = (input: ConsumptionInput): ReadonlyArray<D1PreparedStatement> =>
  consumptionStatements(input, "required");

export const bindConsumptionRetry = (
  input: ConsumptionInput & Readonly<{ retryIdentity: string }>
): D1PreparedStatement =>
  input.db
    .prepare(`UPDATE commercial_allowance_consumptions SET identity = ?
    WHERE user_id = ? AND allowance = ? AND identity = ?
      AND EXISTS (SELECT 1 FROM (${input.authority.sql}) WHERE userId = ?)`)
    .bind(
      input.retryIdentity,
      input.userId,
      input.allowance,
      input.identity,
      ...input.authority.params,
      input.userId
    );

export const prepareAvailableConsumption = (
  input: ConsumptionInput
): ReadonlyArray<D1PreparedStatement> => consumptionStatements(input, "if-available");

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

export const quotaFailure = (failure: unknown): "exhausted" | "authority" | "unavailable" => {
  const text = String(failure);
  if (/commercial_quota_exhausted: SQLITE_CONSTRAINT/u.test(text)) return "exhausted";
  if (/commercial_authority_required/u.test(text)) return "authority";
  return "unavailable";
};

export const quotaStatusStatement = (
  input: Readonly<{ db: D1Database; userId: string; current: number }>
): D1PreparedStatement =>
  quotaStatusForUserSelection({
    ...input,
    users: { sql: "SELECT ?", params: [input.userId] },
  });

export const quotaStatusForUserSelection = (
  input: Readonly<{ db: D1Database; users: OwnedStatement; current: number }>
): D1PreparedStatement => {
  const standing = quotaStatusSelection(input);
  return input.db.prepare(standing.sql).bind(...standing.params);
};

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

export const prepareAuthorizedQuotaRead = ({
  db,
  userId,
  current,
  authority,
}: Readonly<{
  db: D1Database;
  userId: string;
  current: number;
  authority: OwnedStatement;
}>): ReadonlyArray<D1PreparedStatement> => [
  preparePredicateCheck({
    db,
    scope: "commercial_allowance",
    predicate: {
      sql: `SELECT 1 FROM (${authority.sql}) WHERE userId = ?`,
      params: [...authority.params, userId],
    },
  }),
  quotaStatusStatement({ db, userId, current }),
];

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

const unavailable = (): Response =>
  Response.json(
    { error: { code: "unavailable", message: "Quota inspection is unavailable." }, next: [] },
    { status: 503 }
  );

export const executeProtectedQuotaQuery = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: QueryCaller }>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const authority = callerAuthority({ subject, current });
    const auditId = newId();
    const rows = yield* Effect.tryPromise(() =>
      db.batch([
        ...prepareAuthorizedQuotaRead({
          db,
          userId: subject.userId,
          current,
          authority: {
            sql: `SELECT user_id AS userId FROM ${authority.table} WHERE ${authority.predicate}`,
            params: authority.bindings,
          },
        }),
        prepareAuthorizedAuditCall({
          db,
          authority,
          id: auditId,
          operation: "quota.getQuota",
          outcome: "accepted",
          current,
          afterOwnerWrite: false,
        }),
        ...(isPATCaller(subject)
          ? [
              recordAuditedPATUseFromAuthority({
                authority: livePATAuthority({ subject, current }),
                current,
                evidence: recordedPATCallProof({ auditId, operation: "quota.getQuota" }),
              }),
            ].map(({ sql, params }) => db.prepare(sql).bind(...params))
          : []),
      ])
    );
    const status = decodeQuotaStatus({ row: rows[1]?.results[0], current });
    if (Option.isNone(status) || rows[2]?.meta.changes !== 1) return unavailable();
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(QuotaStatus))(status.value);
    return Response.json({ data, next: [] }, { headers: { "cache-control": "no-store" } });
  }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())));
