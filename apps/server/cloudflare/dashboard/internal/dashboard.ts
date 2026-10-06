import { Data, Effect, Schema } from "effect";
import {
  prepareAuthorizedAuditCall,
  recordCanonicalPATWork,
  refusedByAuditBudget,
} from "../../../src/shell/audit/operations";
import { RequestBodyPolicy } from "../../http/contract";

import { DashboardUnavailable } from "../../../src/shell/dashboard/contract";
import { livePATAuthority, recordLivePATUse } from "../../../src/shell/tokens/operations";
import { prepareOwnedStatement } from "../../database/operations";
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
      const audit = isPATCaller(subject)
        ? prepareOwnedStatement({
            db,
            statement: recordCanonicalPATWork({
              authority: livePATAuthority({ subject, current }),
              input: {
                id: transactionId(),
                current,
                operation,
                outcome: "accepted",
                afterOwnerWrite: false,
              },
            }),
          })
        : prepareAuthorizedAuditCall({
            db,
            authority,
            id: transactionId(),
            operation,
            outcome: "accepted",
            current,
            afterOwnerWrite: false,
          });
      return db.batch([
        ...(isPATCaller(subject)
          ? [prepareOwnedStatement({ db, statement: recordLivePATUse({ subject, current }) })]
          : []),
        audit,
        db.prepare(dashboardCompletion),
      ]);
    },
    catch: (cause) =>
      refusedByAuditBudget(cause) ? new DashboardQueryLimited() : new DashboardUnavailable(),
  }).pipe(Effect.asVoid);
