import { Clock, Effect, Option, Schema } from "effect";
import { QuotaStatus } from "../../../src/core/quotas/contract";
import {
  prepareAuthorizedAuditCall,
  recordedPATCallProof,
  refusedByAuditBudget,
} from "../../../src/shell/audit/operations";
import { liveWebSessionAuthority } from "../../../src/shell/identity/operations";
import {
  livePATAuthority,
  recordAuditedPATUseFromAuthority,
} from "../../../src/shell/tokens/operations";
import {
  type TransactionCaller,
  isPATCaller,
  rateLimitedTransactionResponse,
} from "../../canonical-work/operations";
import { newId } from "../../secret-material/operations";
import { prepareOwnedStatement } from "../../database/operations";
import { decodeQuotaStatus, prepareAuthorizedQuotaRead } from "./standing";

const unavailable = (): Response =>
  Response.json(
    { error: { code: "unavailable", message: "Quota inspection is unavailable." }, next: [] },
    { status: 503 }
  );

/** The same guarded, attributable independent-meter query for every canonical caller. */
export const queryQuota = ({
  db,
  subject,
}: Readonly<{ db: D1Database; subject: TransactionCaller }>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const authority = isPATCaller(subject)
      ? livePATAuthority({ subject, current })
      : liveWebSessionAuthority({ subject, current });
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
              prepareOwnedStatement({
                db,
                statement: recordAuditedPATUseFromAuthority({
                  authority: livePATAuthority({ subject, current }),
                  current,
                  evidence: recordedPATCallProof({ auditId, operation: "quota.getQuota" }),
                }),
              }),
            ]
          : []),
      ])
    );
    const status = decodeQuotaStatus({ row: rows[1]?.results[0], current });
    if (Option.isNone(status) || rows[3]?.meta.changes !== 1) return unavailable();
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(QuotaStatus))(status.value);
    return Response.json({ data, next: [] }, { headers: { "cache-control": "no-store" } });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed(refusedByAuditBudget(cause) ? rateLimitedTransactionResponse() : unavailable())
    )
  );
