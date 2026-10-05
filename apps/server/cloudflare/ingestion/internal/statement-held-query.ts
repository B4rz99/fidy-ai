import { Data, Effect, Option, Result, Schema } from "effect";
import { getCanonicalOperationInput } from "../../../src/shell/canonical-operations/operations";
import {
  prepareAuthorizedAuditCall,
  refusedByAuditBudget,
} from "../../../src/shell/audit/operations";
import { newId } from "../../secret-material/operations";
import type { StatementDecisionWork } from "../contract";
import { statementOriginGuard } from "./statement-scope";
import { ReviewPage, pageSize, readCanonicalReviewPage } from "./statement-review";
import {
  readCanonicalSubmission,
  statementDailyBudgetResponse,
  unavailableStatement,
  validationFailed,
} from "./statement-ingestion";

export type HostedStatementQuery =
  | "ingestion.listNeedsReviewItems"
  | "ingestion.getStatementSubmission";
class HeldReadFailed extends Data.TaggedError("HeldReadFailed")<{ readonly cause: unknown }> {}
const listInput = Schema.toType(getCanonicalOperationInput("ingestion.listNeedsReviewItems"));
const submissionInput = Schema.toType(
  getCanonicalOperationInput("ingestion.getStatementSubmission")
);

const readAudit = (
  work: StatementDecisionWork,
  operation: HostedStatementQuery
): Effect.Effect<Option.Option<Response>> =>
  Effect.gen(function* () {
    if (work.authority.table !== "hosted_turns") return Option.some(unavailableStatement());
    const audit = prepareAuthorizedAuditCall({
      db: work.db,
      authority: work.authority,
      id: newId(),
      current: work.current,
      operation,
      outcome: "success",
      afterOwnerWrite: false,
    });
    const result = yield* Effect.result(
      Effect.tryPromise({
        try: () => work.db.batch([audit]),
        catch: (cause) => new HeldReadFailed({ cause }),
      })
    );
    if (Result.isFailure(result)) {
      return Option.some(
        refusedByAuditBudget(result.failure.cause)
          ? statementDailyBudgetResponse()
          : unavailableStatement()
      );
    }
    return result.success[0]?.meta.changes === 1
      ? Option.none()
      : Option.some(unavailableStatement());
  });

const readReviews = (work: StatementDecisionWork): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const input = Schema.decodeUnknownOption(listInput)(work.input);
    if (Option.isNone(input)) return validationFailed("Invalid review page.");
    const page = Schema.decodeOption(ReviewPage)({
      offset: String(Option.getOrElse(input.value.query.offset, () => 0)),
      limit: String(Option.getOrElse(input.value.query.limit, () => pageSize)),
      status: Option.getOrNull(input.value.query.status),
    });
    if (Option.isNone(page)) return validationFailed("Invalid review page.");
    const origin = statementOriginGuard({ work, submission: "r.submission_id" });
    return yield* readCanonicalReviewPage({
      database: work.db,
      userId: work.userId,
      asOf: work.current,
      includeEmail: false,
      page: page.value,
      scope: Option.some({
        sql: `EXISTS (SELECT 1 FROM ${work.authority.table} WHERE ${work.authority.predicate}) AND (${origin.sql})`,
        params: [...work.authority.bindings, ...origin.params],
      }),
    });
  }).pipe(Effect.orElseSucceed(unavailableStatement));

const readSubmission = (work: StatementDecisionWork): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const input = Schema.decodeUnknownOption(submissionInput)(work.input);
    if (Option.isNone(input) || Option.isNone(work.bucket)) return unavailableStatement();
    const id = input.value.params.id;
    const origin = statementOriginGuard({ work, submission: "statement_submissions.id" });
    return yield* readCanonicalSubmission({
      config: { database: work.db },
      userId: work.userId,
      submissionId: id,
      scope: Option.some({
        sql: `(${origin.sql}) AND EXISTS (SELECT 1 FROM ${work.authority.table} WHERE ${work.authority.predicate})`,
        params: [...origin.params, ...work.authority.bindings],
      }),
    });
  }).pipe(Effect.orElseSucceed(unavailableStatement));

/** The ordinary canonical queries, scoped to the verified upload conversation and attributed first. */
export const readHeldStatementQuery = ({
  operation,
  work,
}: Readonly<{
  operation: HostedStatementQuery;
  work: StatementDecisionWork;
}>): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const refused = yield* readAudit(work, operation);
    if (Option.isSome(refused)) return refused.value;
    return yield* operation === "ingestion.listNeedsReviewItems"
      ? readReviews(work)
      : readSubmission(work);
  });
