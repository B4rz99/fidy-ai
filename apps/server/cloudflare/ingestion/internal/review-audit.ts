import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
import { ReviewUnavailable } from "../contract";
import { Effect } from "effect";
import { prepareAuthorizedAuditCall } from "../../../src/shell/audit/operations";
import { recordLivePATUse } from "../../../src/shell/tokens/operations";
import {
  type QueryCaller,
  callerAuthority,
  isPATCaller,
  transactionFailure,
  transactionId,
  transactionUnavailable,
} from "../../canonical-work/operations";
import type { CanonicalMutationRefusal } from "../../canonical-operations/contract";

type Work = Readonly<{ db: D1Database; subject: QueryCaller; current: number }>;
type Operation =
  | "ingestion.getReviewWorkspace"
  | "ingestion.getReviewMaterial"
  | "ingestion.getReviewItem"
  | "ingestion.applyReviewEdit";
export const reviewAudit = ({
  work,
  operation,
  accepted,
}: Readonly<{
  work: Work;
  operation: Operation;
  accepted: boolean;
}>): ReadonlyArray<D1PreparedStatement> => {
  const use = isPATCaller(work.subject)
    ? [recordLivePATUse({ subject: work.subject, current: work.current })].map(({ sql, params }) =>
        work.db.prepare(sql).bind(...params)
      )
    : [];
  return [
    ...use,
    prepareAuthorizedAuditCall({
      db: work.db,
      authority: callerAuthority(work),
      id: transactionId(),
      current: work.current,
      operation,
      outcome: accepted ? "accepted" : "rejected",
      afterOwnerWrite: false,
    }),
  ];
};
export const reviewRefusal = (work: Work): CanonicalMutationRefusal => ({
  code: "validation_failed",
  message: "Actualiza el elemento y revisa los datos antes de continuar.",
  record: () =>
    Effect.tryPromise(() =>
      work.db.batch([
        ...reviewAudit({ work, operation: "ingestion.applyReviewEdit", accepted: false }),
        prepareChangedRowAssertion({ db: work.db, scope: "ingestion_review" }),
      ])
    ).pipe(
      Effect.as("recorded" as const),
      Effect.orElseSucceed(() => "unavailable" as const)
    ),
  respond: (disposition) =>
    Effect.succeed(
      disposition === "recorded"
        ? transactionFailure({
            code: "validation_failed",
            status: 400,
            message: "Actualiza el elemento y revisa los datos antes de continuar.",
          })
        : transactionUnavailable()
    ),
});

export const commitReviewRead = (
  input: Readonly<{ work: Work; operation: Operation; accepted: boolean }>
): Effect.Effect<void, ReviewUnavailable> =>
  Effect.tryPromise(() =>
    input.work.db.batch([
      ...reviewAudit(input),
      prepareChangedRowAssertion({ db: input.work.db, scope: "ingestion_review" }),
    ])
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new ReviewUnavailable())
  );
