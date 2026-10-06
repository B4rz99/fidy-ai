import { type Cause, Data, DateTime, Effect, Option, Schema } from "effect";
import { getCanonicalOperationInput } from "../../../src/shell/canonical-operations/operations";
import {
  prepareAuthorizedAuditCall,
  refusedByAuditBudget,
} from "../../../src/shell/audit/operations";
import { StatementSubmission } from "../../../src/core/ingestion/contract";
import type { TransactionExtraction } from "../../../src/core/transactions/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import type {
  CanonicalMutationPreparation,
  CanonicalMutationRefusal,
  CanonicalPreparationWork,
  CommittedMutationValue,
} from "../../canonical-operations/contract";
import {
  type CanonicalRefusalDisposition,
  acceptedPATAccountability,
  callerAuthority,
  callerScope,
  failedPreparation,
  isPATAuthority,
  refusedPreparation,
  transactionFailure,
  transactionUnavailable,
} from "../../canonical-work/operations";
import { categorizeCaptures } from "../../categories/operations";
import { prepareConsentAction } from "../../consent/operations";
import { findCapturedTransaction, prepareStatementCapture } from "../../transactions/operations";
import { newId } from "../../secret-material/operations";
import type { StatementDecisionWork } from "../contract";
import type { OAuthMutationReview } from "../../oauth-confirmation/contract";
import { clarificationOAuthReview, needsOAuthReview } from "./oauth-review";
import { statementOriginGuard as originGuard } from "./statement-scope";
import { readOwnedStatementSubmission, submissionProjection } from "./statement-staging";
import type { StatementClarificationOperation } from "./clarification-operation";

type ReviewOperation = Exclude<
  StatementClarificationOperation,
  "ingestion.abandonStatementSubmission"
>;
const Review = Schema.Struct({
  id: Schema.String,
  submission_id: Schema.String,
  record_number: Schema.Int,
  service_market: Schema.Literal("CO"),
  locale: Schema.Literal("es-CO"),
  time_zone: Schema.String,
  source_format: Schema.Literals(["csv", "xlsx"]),
  parser_revision: Schema.String,
  sha256: Schema.String,
});
type Review = typeof Review.Type;
const resolveInput = Schema.toType(getCanonicalOperationInput("ingestion.resolveNeedsReviewItem"));
const skipInput = Schema.toType(getCanonicalOperationInput("ingestion.skipNeedsReviewItem"));
const abandonInput = Schema.toType(
  getCanonicalOperationInput("ingestion.abandonStatementSubmission")
);
type Decision = Readonly<{ id: string; extraction: Option.Option<TransactionExtraction> }>;
class ReviewCaptureUnavailable extends Data.TaggedError("ReviewCaptureUnavailable")<{}> {}

const credentialWork = (work: CanonicalPreparationWork): StatementDecisionWork => ({
  db: work.db,
  userId: work.subject.userId,
  authority: callerAuthority({ subject: work.subject, current: work.current }),
  originSessionId: Option.none(),
  originTurns: Option.none(),
  publicationOrigin: Option.none(),
  requiredScope: callerScope(work.subject),
  current: work.current,
  bucket: work.bucket,
  input: work.input,
});
const decodeDecision = (operation: ReviewOperation, input: unknown): Option.Option<Decision> => {
  if (operation === "ingestion.resolveNeedsReviewItem") {
    return Option.map(Schema.decodeUnknownOption(resolveInput)(input), ({ params, payload }) => ({
      id: params.id,
      extraction: Option.some(payload.extraction),
    }));
  }
  return Option.map(Schema.decodeUnknownOption(skipInput)(input), ({ params }) => ({
    id: params.id,
    extraction: Option.none(),
  }));
};

const accountability = (
  work: StatementDecisionWork,
  operation: StatementClarificationOperation,
  accepted: boolean
): ReadonlyArray<D1PreparedStatement> => {
  const authority = work.authority;
  if (authority.table === "oauth_access_credentials") {
    return [
      prepareAuthorizedAuditCall({
        db: work.db,
        authority,
        id: newId(),
        current: work.current,
        operation,
        outcome: accepted ? "accepted" : "rejected",
        afterOwnerWrite: accepted,
      }),
    ];
  }
  if (isPATAuthority(authority)) {
    return accepted
      ? acceptedPATAccountability({
          authority,
          database: work.db,
          current: work.current,
          operation,
          afterOwnerWrite: true,
        })
      : [
          prepareAuthorizedAuditCall({
            db: work.db,
            authority,
            id: newId(),
            current: work.current,
            operation,
            outcome: "rejected",
            afterOwnerWrite: false,
          }),
        ];
  }
  return [
    prepareAuthorizedAuditCall({
      db: work.db,
      authority,
      id: newId(),
      current: work.current,
      operation,
      outcome: accepted ? "success" : "not_found",
      afterOwnerWrite: accepted,
    }),
  ];
};

/** Refusals are attributed without revealing whether a foreign or stale review exists. */
export const heldClarificationRefusal = ({
  work,
  operation,
}: Readonly<{
  work: StatementDecisionWork;
  operation: StatementClarificationOperation;
}>): CanonicalMutationRefusal => ({
  code: "not_found",
  message: "Statement clarification unavailable.",
  record: () =>
    Effect.tryPromise(() => work.db.batch([...accountability(work, operation, false)])).pipe(
      Effect.map((rows): CanonicalRefusalDisposition =>
        rows[0]?.meta.changes === 1 ? "recorded" : "credential_refused"
      ),
      Effect.catch((cause) =>
        Effect.succeed(
          refusedByAuditBudget(cause) ? ("rate_limited" as const) : ("unavailable" as const)
        )
      )
    ),
  respond: (disposition) =>
    Effect.succeed(
      disposition === "recorded"
        ? transactionFailure({
            code: "not_found",
            status: 404,
            message: "Statement clarification unavailable.",
          })
        : transactionUnavailable()
    ),
});

/** Resolve the credential owner's exact live authority before sharing the owner decision. */
export const clarificationRefusal = ({
  work,
  operation,
}: Readonly<{
  work: CanonicalPreparationWork;
  operation: StatementClarificationOperation;
}>): CanonicalMutationRefusal =>
  heldClarificationRefusal({ work: credentialWork(work), operation });

const eligibleReview = (work: StatementDecisionWork, id: string): OwnedStatement => {
  const authority = work.authority;
  const origin = originGuard({ work, submission: "r.submission_id" });
  return {
    sql: `SELECT r.user_id FROM statement_needs_review r JOIN statement_clarifications c
      ON c.submission_id = r.submission_id AND c.user_id = r.user_id
      WHERE r.id = ? AND r.user_id = ? AND r.status = 'pending' AND c.state = 'awaiting'
        AND c.expires_at_ms > ? AND r.evidence_expires_at_ms > ?
        AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate}) AND (${origin.sql})`,
    params: [id, work.userId, work.current, work.current, ...authority.bindings, ...origin.params],
  };
};

const prepareCapture = ({
  work,
  row,
  source,
  transactionId,
  extraction,
}: Readonly<{
  work: StatementDecisionWork;
  row: Review;
  source: OwnedStatement;
  transactionId: string;
  extraction: Option.Option<TransactionExtraction>;
}>): Effect.Effect<
  Readonly<{ statements: ReadonlyArray<D1PreparedStatement>; categoryId: Option.Option<string> }>,
  ReviewCaptureUnavailable
> =>
  Effect.gen(function* () {
    if (Option.isNone(extraction)) return { statements: [], categoryId: Option.none() };
    const categories = yield* categorizeCaptures({
      db: work.db,
      userId: work.userId,
      captures: [
        {
          caller: Option.none(),
          counterparty: extraction.value.counterparty,
          direction: extraction.value.direction,
        },
      ],
    }).pipe(Effect.mapError(() => new ReviewCaptureUnavailable()));
    const categoryId = categories[0];
    if (categoryId === undefined) return yield* new ReviewCaptureUnavailable();
    const statements = prepareStatementCapture({
      db: work.db,
      userId: work.userId,
      transactionId,
      extraction: extraction.value,
      categoryId,
      sourceGuard: source,
      attestation: {
        id: newId(),
        serviceMarket: row.service_market,
        locale: row.locale,
        timeZone: row.time_zone,
        interpretationRevision: row.parser_revision,
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(work.current)),
        statementSubmissionId: row.submission_id,
        statementRecordNumber: row.record_number,
        statementContentHash: row.sha256,
        sourceFormat: row.source_format,
      },
    });
    return { statements, categoryId: Option.some(categoryId) };
  });

const decisionStatement = ({
  work,
  decision,
  row,
  source,
  transactionId,
}: Readonly<{
  work: StatementDecisionWork;
  decision: Decision;
  row: Review;
  source: OwnedStatement;
  transactionId: string;
}>): D1PreparedStatement => {
  const resolving = Option.isSome(decision.extraction);
  return prepareConsentAction({
    db: work.db,
    subject: { _tag: "User", userId: work.userId },
    requirement: "active",
    statement: {
      sql: `INSERT INTO statement_review_decisions (review_id, submission_id, user_id, decision, transaction_id, decided_at_ms)
      SELECT ?, ?, ?, ?, ${resolving ? "?" : "NULL"}, ? WHERE EXISTS (${source.sql})`,
      params: [
        decision.id,
        row.submission_id,
        work.userId,
        resolving ? "resolved" : "skipped",
        ...(resolving ? [transactionId] : []),
        work.current,
        ...source.params,
      ],
    },
  });
};

const readSubmission = ({
  work,
  submissionId,
  db,
  userId,
}: Readonly<{
  work: StatementDecisionWork;
  submissionId: string;
  db: D1Database;
  userId: string;
}>): Effect.Effect<Option.Option<CommittedMutationValue>> => {
  if (Option.isNone(work.bucket)) return Effect.succeedNone;
  return readOwnedStatementSubmission({ database: db }, { userId, submissionId }).pipe(
    Effect.map((stored) =>
      Option.map(Option.flatMap(stored, submissionProjection), (submission) => ({
        _tag: "Owner" as const,
        payload: submission,
        encode: () => Schema.encodeEffect(Schema.toCodecJson(StatementSubmission))(submission),
      }))
    ),
    Effect.orElseSucceed(() => Option.none())
  );
};
const readCapture = (
  db: D1Database,
  userId: string,
  id: string
): Effect.Effect<Option.Option<CommittedMutationValue>> =>
  Effect.tryPromise(() => findCapturedTransaction({ db, userId, id })).pipe(
    Effect.map((found) =>
      Option.map(found, (transaction) => ({ _tag: "Transaction" as const, transaction }))
    ),
    Effect.orElseSucceed(() => Option.none())
  );

const loadEligibleReview = ({
  work,
  id,
  source,
}: Readonly<{ work: StatementDecisionWork; id: string; source: OwnedStatement }>): Effect.Effect<
  Option.Option<Review>,
  ReviewCaptureUnavailable
> =>
  Effect.tryPromise({
    try: () =>
      work.db
        .prepare(`SELECT r.id, r.submission_id, r.record_number, r.service_market, r.locale, r.time_zone, r.source_format, r.parser_revision, o.sha256
      FROM statement_needs_review r JOIN statement_submissions s ON s.id = r.submission_id AND s.user_id = r.user_id
      JOIN statement_staging_objects o ON o.id = s.staging_id AND o.user_id = s.user_id
      WHERE r.id = ? AND r.user_id = ? AND EXISTS (${source.sql})`)
        .bind(id, work.userId, ...source.params)
        .first(),
    catch: () => new ReviewCaptureUnavailable(),
  }).pipe(
    Effect.flatMap((value) =>
      value === null
        ? Effect.succeedNone
        : Schema.decodeUnknownEffect(Review)(value).pipe(
            Effect.asSome,
            Effect.mapError(() => new ReviewCaptureUnavailable())
          )
    )
  );

const observeReview = ({
  work,
  operation,
  decision,
  oauth,
}: Readonly<{
  work: StatementDecisionWork;
  operation: ReviewOperation;
  decision: Decision;
  oauth: boolean;
}>): Effect.Effect<
  Option.Option<
    Readonly<{
      row: Review;
      source: OwnedStatement;
      observed: Option.Option<Effect.Success<ReturnType<typeof clarificationOAuthReview>>>;
    }>
  >,
  ReviewCaptureUnavailable | Effect.Error<ReturnType<typeof clarificationOAuthReview>>
> =>
  Effect.gen(function* () {
    let source = eligibleReview(work, decision.id);
    let row = yield* loadEligibleReview({ work, id: decision.id, source });
    if (Option.isNone(row)) return Option.none();
    const observed = oauth
      ? Option.some(
          yield* clarificationOAuthReview({
            db: work.db,
            userId: work.userId,
            submissionId: row.value.submission_id,
            operation,
            reviewId: Option.some(decision.id),
            extraction: decision.extraction,
          })
        )
      : Option.none();
    if (Option.isSome(observed)) {
      source = {
        sql: `SELECT user_id FROM (${source.sql}) WHERE EXISTS (${observed.value.guard.sql})`,
        params: [...source.params, ...observed.value.guard.params],
      };
      row = yield* loadEligibleReview({ work, id: decision.id, source });
    }
    return Option.map(row, (value) => ({ row: value, source, observed }));
  });

const discloseCaptureCategory = (
  review: OAuthMutationReview,
  category: Option.Option<string>
): OAuthMutationReview =>
  Option.match(category, {
    onNone: () => review,
    onSome: (categoryId) => ({
      ...review,
      effect: `${review.effect} Categoría de la nueva Transacción: ${categoryId}.`,
      revision: `${review.revision}:${categoryId}`,
    }),
  });

/** One atomic row decision, independent of the caller's credential kind. The caller commits its unit. */
const prepareReviewDecision = ({
  operation,
  work,
  oauth,
}: Readonly<{
  operation: ReviewOperation;
  work: StatementDecisionWork;
  oauth: boolean;
}>): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    const decision = decodeDecision(operation, work.input);
    if (Option.isNone(decision)) return failedPreparation();
    const eligible = yield* observeReview({ work, operation, decision: decision.value, oauth });
    if (Option.isNone(eligible)) {
      return refusedPreparation(heldClarificationRefusal({ work, operation }));
    }
    const { row, source, observed } = eligible.value;
    const transactionId = newId();
    const captures = yield* prepareCapture({
      work,
      row,
      source,
      transactionId,
      extraction: decision.value.extraction,
    });
    return {
      _tag: "Prepared",
      mutation: {
        oauthReview: Option.map(observed, ({ review }) =>
          discloseCaptureCategory(review, captures.categoryId)
        ),
        requiredScope: work.requiredScope,
        statements: [
          ...captures.statements,
          decisionStatement({
            work,
            decision: decision.value,
            row,
            source,
            transactionId,
          }),
          ...accountability(work, operation, true),
        ],
        auditBudget: "shared",
        commitGuards: Option.none(),
        guardRefusal: () => Effect.succeed(heldClarificationRefusal({ work, operation })),
        outcome: {
          _tag: "Owner",
          operation,
          collisionKey: Option.some(`statement-review:${decision.value.id}`),
          guardFacts: Option.none(),
          triggerRefusal: () => Option.some(heldClarificationRefusal({ work, operation })),
          read: (db, userId) =>
            Option.isSome(decision.value.extraction)
              ? readCapture(db, userId, transactionId)
              : readSubmission({ work, submissionId: row.submission_id, db, userId }),
        },
      },
    } satisfies CanonicalMutationPreparation;
  }).pipe(Effect.orElseSucceed(failedPreparation));

/** Held conversation authority preserves its existing confirmation and settlement semantics. */
export const prepareHeldStatementReviewDecision = (
  input: Readonly<{
    operation: ReviewOperation;
    work: StatementDecisionWork;
  }>
): Effect.Effect<CanonicalMutationPreparation> => prepareReviewDecision({ ...input, oauth: false });

/** Canonical credential adapter uses precisely the same decision as the verified hosted adapter. */
export const prepareStatementReviewDecision = ({
  operation,
  work,
}: Readonly<{
  operation: ReviewOperation;
  work: CanonicalPreparationWork;
}>): Effect.Effect<CanonicalMutationPreparation> =>
  prepareReviewDecision({
    operation,
    work: credentialWork(work),
    oauth: needsOAuthReview({ subject: work.subject, operation }),
  });

/** Permanent cancellation preserves captures and erases all remaining clarification evidence. */
const eligibleAbandonment = (
  work: StatementDecisionWork,
  id: string,
  origin: OwnedStatement
): Effect.Effect<boolean, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    work.db
      .prepare(
        `SELECT 1 FROM statement_clarifications WHERE submission_id = ? AND user_id = ? AND state = 'awaiting' AND expires_at_ms > ? AND (${origin.sql}) AND EXISTS (SELECT 1 FROM ${work.authority.table} WHERE ${work.authority.predicate})`
      )
      .bind(id, work.userId, work.current, ...origin.params, ...work.authority.bindings)
      .first()
  ).pipe(Effect.map((row) => row !== null));

const abandonmentStatement = (
  work: StatementDecisionWork,
  id: string,
  origin: OwnedStatement
): D1PreparedStatement =>
  prepareConsentAction({
    db: work.db,
    subject: { _tag: "User", userId: work.userId },
    requirement: "active",
    statement: {
      sql: `UPDATE statement_clarifications SET state = 'abandoned', ended_at_ms = ? WHERE submission_id = ? AND user_id = ? AND state = 'awaiting' AND expires_at_ms > ?
        AND EXISTS (SELECT 1 FROM ${work.authority.table} WHERE ${work.authority.predicate}) AND (${origin.sql})`,
      params: [
        work.current,
        id,
        work.userId,
        work.current,
        ...work.authority.bindings,
        ...origin.params,
      ],
    },
  });

const prepareAbandonment = (
  work: StatementDecisionWork,
  oauth: boolean
): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    const parsed = Schema.decodeUnknownOption(abandonInput)(work.input);
    if (Option.isNone(parsed)) return failedPreparation();
    const id = parsed.value.params.id;
    const operation = "ingestion.abandonStatementSubmission";
    const origin = originGuard({ work, submission: "statement_clarifications.submission_id" });
    if (!(yield* eligibleAbandonment(work, id, origin))) {
      return refusedPreparation(heldClarificationRefusal({ work, operation }));
    }
    const observed = oauth
      ? Option.some(
          yield* clarificationOAuthReview({
            db: work.db,
            userId: work.userId,
            submissionId: id,
            operation,
            reviewId: Option.none(),
            extraction: Option.none(),
          })
        )
      : Option.none();
    return {
      _tag: "Prepared",
      mutation: {
        oauthReview: Option.map(observed, ({ review }) => review),
        requiredScope: work.requiredScope,
        auditBudget: "shared",
        commitGuards: Option.none(),
        guardRefusal: () => Effect.succeed(heldClarificationRefusal({ work, operation })),
        statements: [
          abandonmentStatement(work, id, origin),
          ...accountability(work, operation, true),
        ],
        outcome: {
          _tag: "Owner",
          operation,
          collisionKey: Option.some(`statement:${id}`),
          guardFacts: Option.none(),
          triggerRefusal: () => Option.some(heldClarificationRefusal({ work, operation })),
          read: (db, userId) => readSubmission({ work, submissionId: id, db, userId }),
        },
      },
    } satisfies CanonicalMutationPreparation;
  }).pipe(Effect.orElseSucceed(failedPreparation));

/** Held cancellation retains the original conversation authority and confirmation contract. */
export const prepareHeldStatementAbandonment = (
  work: StatementDecisionWork
): Effect.Effect<CanonicalMutationPreparation> => prepareAbandonment(work, false);

/** Canonical credential cancellation adapter; no nested commit or borrowed channel authority. */
export const prepareStatementAbandonment = (
  work: CanonicalPreparationWork
): Effect.Effect<CanonicalMutationPreparation> =>
  prepareAbandonment(
    credentialWork(work),
    needsOAuthReview({ subject: work.subject, operation: "ingestion.abandonStatementSubmission" })
  );
