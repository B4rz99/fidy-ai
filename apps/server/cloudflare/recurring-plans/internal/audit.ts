import { Effect } from "effect";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
} from "../../../src/shell/audit/operations";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import {
  type QueryCaller,
  callerAuthority,
  isPATCaller,
  transactionFailure,
  transactionId,
} from "../../canonical-work/operations";
import type { CanonicalMutationRefusal } from "../../canonical-operations/contract";
import type { RecurringOperation } from "../contract";

type Work = Readonly<{ db: D1Database; subject: QueryCaller; current: number }>;
export const credentialUse = (work: Work): ReadonlyArray<D1PreparedStatement> =>
  isPATCaller(work.subject)
    ? [recordLivePATUse({ subject: work.subject, current: work.current })].map(({ sql, params }) =>
        work.db.prepare(sql).bind(...params)
      )
    : [];
export const audit = ({
  work,
  operation,
  outcome,
}: Readonly<{
  work: Work;
  operation: RecurringOperation;
  outcome: "accepted" | "rejected";
}>): D1PreparedStatement => {
  if (isPATCaller(work.subject)) {
    const statement = recordCanonicalPATWork({
      authority: livePATAuthority({ subject: work.subject, current: work.current }),
      input: {
        id: transactionId(),
        current: work.current,
        operation,
        outcome,
        afterOwnerWrite: false,
      },
    });
    return work.db.prepare(statement.sql).bind(...statement.params);
  }
  return prepareAuthorizedAuditCall({
    db: work.db,
    authority: callerAuthority(work),
    id: transactionId(),
    current: work.current,
    operation,
    outcome,
    afterOwnerWrite: false,
  });
};
export const recurringLimitRefusal = (): CanonicalMutationRefusal => ({
  code: "rate_limited",
  message: "Se alcanzó el límite diario de operaciones.",
  record: () => Effect.succeed("rate_limited" as const),
  respond: () =>
    Effect.succeed(
      transactionFailure({
        code: "rate_limited",
        status: 429,
        message: "Se alcanzó el límite diario de operaciones.",
      })
    ),
});
