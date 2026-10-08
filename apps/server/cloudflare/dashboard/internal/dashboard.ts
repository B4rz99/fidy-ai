import { Data, Effect, Schema } from "effect";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
  refusedByAuditBudget,
} from "../../../src/shell/audit/operations";
import { RequestBodyPolicy } from "../../http/contract";
import { DashboardUnavailable } from "../../../src/shell/dashboard/contract";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import {
  type QueryCaller,
  callerAuthority,
  isPATCaller,
  transactionId,
} from "../../canonical-work/operations";
import { dashboardCompletion } from "./dashboard-mutation";
import { type DashboardQueryOperation } from "../contract";

export const editBodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16_384,
  deadlineMilliseconds: 2_000,
});

class DashboardQueryLimited extends Data.TaggedError("DashboardQueryLimited") {}

/** Query accounting rechecks authority; its only writes are credential and Audit metadata. */
export const accountQuery = ({
  db,
  subject,
  current,
  operation,
}: Readonly<{
  db: D1Database;
  subject: QueryCaller;
  current: number;
  operation: DashboardQueryOperation;
}>): Effect.Effect<void, DashboardQueryLimited | DashboardUnavailable> =>
  Effect.tryPromise({
    try: () => {
      const authority = callerAuthority({ subject, current });
      let audit: D1PreparedStatement;
      if (isPATCaller(subject)) {
        const auditStatement = recordCanonicalPATWork({
          authority: livePATAuthority({ subject, current }),
          input: {
            id: transactionId(),
            current,
            operation,
            outcome: "accepted",
            afterOwnerWrite: false,
          },
        });
        audit = db.prepare(auditStatement.sql).bind(...auditStatement.params);
      } else {
        audit = prepareAuthorizedAuditCall({
          db,
          authority,
          id: transactionId(),
          operation,
          outcome: "accepted",
          current,
          afterOwnerWrite: false,
        });
      }
      return db.batch([
        ...(isPATCaller(subject)
          ? [recordLivePATUse({ subject, current })].map(({ sql, params }) =>
              db.prepare(sql).bind(...params)
            )
          : []),
        audit,
        db.prepare(dashboardCompletion),
      ]);
    },
    catch: (cause) =>
      refusedByAuditBudget(cause) ? new DashboardQueryLimited() : new DashboardUnavailable(),
  }).pipe(Effect.asVoid);
