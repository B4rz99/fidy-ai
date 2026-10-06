import { getCanonicalOperationInput } from "../../../src/shell/canonical-operations/operations";
import type { StatementDecisionWork } from "../contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { StatementSubmission } from "../../../src/shell/ingestion/contract";
import { Effect, Exit, Option, Schema } from "effect";
import { dailyAuditExhausted } from "../../../src/shell/audit/operations";
import {
  type PreparedStatementPublication,
  type StatementPublicationRefusal,
  type StatementStagingConfig,
  lostStatementReplay,
  prepareStagedStatementPublication,
  readOwnedStatementSubmission,
  recordStatementRefusal,
  statementAbortRefusal,
  statementRefusal,
  statementSubmissionCompletion,
  submissionProjection,
} from "./statement-staging";
import {
  statementDailyBudgetMessage,
  statementDailyBudgetResponse,
  statementRefusalResponse,
} from "./statement-ingestion";
import {
  type TransactionCaller,
  callerAuthority,
  callerScope,
  failedPreparation,
  refusedPreparation,
  transactionNoStore,
  transactionUnavailable,
  unavailablePreparation,
} from "../../canonical-work/operations";
import {
  type CanonicalMutationPreparation,
  type CanonicalMutationRefusal,
  type CanonicalPreparationWork,
  type CommittedMutationValue,
  type GuardRefusalWork,
} from "../../canonical-operations/contract";

const StatementInput = Schema.toType(getCanonicalOperationInput("ingestion.submitForExtraction"));
/** One statement-owned budget policy; a trigger abort cannot promise an individual HTTP refusal. */
export const statementDailyBudgetRefusal = (
  phase: "preflight" | "trigger"
): CanonicalMutationRefusal => ({
  code: "rate_limited",
  message: statementDailyBudgetMessage,
  record: () => Effect.succeed("rate_limited" as const),
  respond: () =>
    Effect.succeed(
      phase === "preflight" ? statementDailyBudgetResponse() : transactionUnavailable()
    ),
});

/** Preserve the statement owner's metadata-only refusal audit and individual response. */
export const canonicalStatementRefusal = ({
  config,
  subject,
  current,
  refusal,
}: Readonly<{
  config: StatementStagingConfig;
  subject: TransactionCaller;
  current: number;
  refusal: StatementPublicationRefusal;
}>): CanonicalMutationRefusal => ({
  code: refusal.code,
  message: refusal.message,
  record: () =>
    Effect.tryPromise(() =>
      recordStatementRefusal({
        authority: callerAuthority({ subject, current }),
        current,
        database: config.database,
        refusal,
      })
    ).pipe(Effect.orElseSucceed(() => "unavailable" as const)),
  respond: (disposition) => {
    if (disposition === "recorded") return Effect.succeed(statementRefusalResponse(refusal));
    if (disposition === "rate_limited") return Effect.succeed(statementDailyBudgetResponse());
    return Effect.succeed(transactionUnavailable());
  },
});

const guardedStatementRefusal =
  (config: StatementStagingConfig, publication: PreparedStatementPublication) =>
  ({ subject, current }: GuardRefusalWork): Effect.Effect<CanonicalMutationRefusal> => {
    const generic = canonicalStatementRefusal({
      config,
      subject,
      current,
      refusal: {
        code: "validation_failed",
        auditOutcome: "validation_failed",
        message: "The statement submission could not complete.",
      },
    });
    return statementAbortRefusal(config, publication).pipe(
      Effect.map(
        Option.match({
          onNone: () => generic,
          onSome: (refusal) => canonicalStatementRefusal({ config, subject, current, refusal }),
        })
      )
    );
  };

/** Read only public lifecycle after the unit commits; transient adapter failures get bounded retries. */
const committedSubmission =
  (config: StatementStagingConfig, publication: PreparedStatementPublication) =>
  (userId: string): Effect.Effect<Option.Option<StatementSubmission>> =>
    Effect.gen(function* () {
      const read = readOwnedStatementSubmission(config, {
        userId,
        submissionId: publication.submissionId,
      });
      let result = yield* Effect.exit(read);
      for (let attempt = 1; attempt < 3 && Exit.isFailure(result); attempt += 1) {
        result = yield* Effect.exit(read);
      }
      return Exit.isFailure(result)
        ? Option.none()
        : Option.flatMap(result.value, submissionProjection);
    });

const heldPublicationRefusal = ({
  work,
  config,
  refusal,
}: Readonly<{
  work: StatementDecisionWork;
  config: StatementStagingConfig;
  refusal: StatementPublicationRefusal;
}>): CanonicalMutationRefusal => ({
  code: refusal.code,
  message: refusal.message,
  record: () =>
    Effect.tryPromise(() =>
      recordStatementRefusal({
        authority: work.authority,
        current: work.current,
        database: config.database,
        refusal,
      })
    ).pipe(Effect.orElseSucceed(() => "unavailable" as const)),
  respond: (disposition) => {
    if (disposition === "recorded") return Effect.succeed(statementRefusalResponse(refusal));
    if (disposition === "rate_limited") return Effect.succeed(statementDailyBudgetResponse());
    return Effect.succeed(transactionUnavailable());
  },
});

const bindPublicationOrigin = ({
  work,
  origin,
  submissionId,
  stagingId,
}: Readonly<{
  work: StatementDecisionWork;
  origin: OwnedStatement;
  submissionId: string;
  stagingId: string;
}>): ReadonlyArray<D1PreparedStatement> => [
  work.db
    .prepare(`INSERT INTO statement_hosted_origins (submission_id,user_id,session_id,turn_id,expires_at_ms)
      SELECT ?,user_id,session_id,turn_id,expires_at_ms FROM (${origin.sql}) AS proof WHERE user_id = ? AND EXISTS (SELECT 1 FROM statement_whatsapp_documents d WHERE d.turn_id=proof.turn_id AND d.user_id=proof.user_id AND d.staging_id=?)
      ON CONFLICT(submission_id) DO UPDATE SET expires_at_ms = statement_hosted_origins.expires_at_ms
      WHERE statement_hosted_origins.user_id = excluded.user_id AND statement_hosted_origins.session_id = excluded.session_id AND statement_hosted_origins.turn_id = excluded.turn_id`)
    .bind(submissionId, ...origin.params, work.userId, stagingId),
  work.db.prepare(statementSubmissionCompletion),
];

const heldPublicationConfig = ({
  work,
  bucket,
}: Readonly<{ work: StatementDecisionWork; bucket: R2Bucket }>): StatementStagingConfig => ({
  database: work.db,
  bucket,
  nowEpochMs: () => work.current,
});

/** Publish using the same staging/entitlement unit and atomically bind verified upload provenance. */
export const prepareHeldStatementSubmission = (
  work: StatementDecisionWork
): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    if (
      Option.isNone(work.bucket) ||
      Option.isNone(work.publicationOrigin) ||
      work.authority.table !== "hosted_turns"
    ) {
      return unavailablePreparation();
    }
    const parsed = Schema.decodeUnknownOption(StatementInput)(work.input);
    if (Option.isNone(parsed)) return failedPreparation();
    const config = heldPublicationConfig({ work, bucket: work.bucket.value });
    const prepared = yield* prepareStagedStatementPublication(config, {
      authority: work.authority,
      current: work.current,
      idempotencyKey: parsed.value.payload.idempotencyKey,
      reference: parsed.value.payload.reference,
      userId: work.userId,
    });
    if (prepared._tag === "Unavailable") return unavailablePreparation();
    if (prepared._tag === "Refused") {
      return refusedPreparation(
        heldPublicationRefusal({ work, config, refusal: statementRefusal(prepared.reason) })
      );
    }
    const publication = prepared.publication;
    const origin = work.publicationOrigin.value;
    return {
      _tag: "Prepared",
      mutation: {
        oauthReview: Option.none(),
        requiredScope: Option.none(),
        auditBudget: "shared",
        commitGuards: Option.none(),
        statements: [
          ...publication.statements,
          ...bindPublicationOrigin({
            work,
            origin,
            submissionId: publication.submissionId,
            stagingId: parsed.value.payload.reference.stagingId,
          }),
        ],
        guardRefusal: () =>
          Effect.succeed(
            heldPublicationRefusal({ work, config, refusal: statementRefusal("conflict") })
          ),
        outcome: {
          _tag: "StatementSubmission",
          operation: "ingestion.submitForExtraction",
          publication: {
            readCommitted: committedSubmission(config, publication),
            lostReplay: lostStatementReplay(config, publication),
          },
        },
      },
    } satisfies CanonicalMutationPreparation;
  }).pipe(Effect.orElseSucceed(unavailablePreparation));

/** One staged reference prepared for the shared canonical mutation unit, never a nested commit. */
export const statementMutationAdapter = {
  prepare: (work: CanonicalPreparationWork): Effect.Effect<CanonicalMutationPreparation> =>
    Effect.gen(function* () {
      if (Option.isNone(work.bucket)) return unavailablePreparation();
      const config: StatementStagingConfig = {
        database: work.db,
        bucket: work.bucket.value,
        nowEpochMs: () => work.current,
      };
      const parsed = Schema.decodeUnknownOption(StatementInput)(work.input);
      if (Option.isNone(parsed)) return failedPreparation();
      const spent = yield* Effect.tryPromise(() =>
        dailyAuditExhausted({ db: work.db, userId: work.subject.userId, current: work.current })
      ).pipe(Effect.option);
      if (Option.isNone(spent)) return failedPreparation();
      if (spent.value) {
        return refusedPreparation(statementDailyBudgetRefusal("preflight"));
      }
      const prepared = yield* prepareStagedStatementPublication(config, {
        authority: callerAuthority({ subject: work.subject, current: work.current }),
        current: work.current,
        idempotencyKey: parsed.value.payload.idempotencyKey,
        reference: parsed.value.payload.reference,
        userId: work.subject.userId,
      }).pipe(Effect.option);
      if (Option.isNone(prepared)) return unavailablePreparation();
      if (prepared.value._tag === "Unavailable") return unavailablePreparation();
      if (prepared.value._tag === "Refused") {
        return refusedPreparation(
          canonicalStatementRefusal({
            config,
            subject: work.subject,
            current: work.current,
            refusal: statementRefusal(prepared.value.reason),
          })
        );
      }
      const publication = prepared.value.publication;
      return {
        _tag: "Prepared",
        mutation: {
          oauthReview: Option.none(),
          requiredScope: callerScope(work.subject),
          statements: publication.statements,
          guardRefusal: guardedStatementRefusal(config, publication),
          auditBudget: "shared",
          commitGuards: Option.none(),
          outcome: {
            _tag: "StatementSubmission",
            operation: "ingestion.submitForExtraction",
            publication: {
              readCommitted: committedSubmission(config, publication),
              lostReplay: lostStatementReplay(config, publication),
            },
          },
        },
      } as const satisfies CanonicalMutationPreparation;
    }),
  present: (value: CommittedMutationValue): Effect.Effect<Response> =>
    value._tag === "StatementSubmission"
      ? Schema.encodeEffect(Schema.toCodecJson(StatementSubmission))(value.submission).pipe(
          Effect.map((data) =>
            Response.json({ data, next: [] }, { status: 202, headers: transactionNoStore })
          ),
          Effect.orElseSucceed(transactionUnavailable)
        )
      : Effect.succeed(transactionUnavailable()),
  invalidRefusal: (work: CanonicalPreparationWork): CanonicalMutationRefusal => {
    if (Option.isNone(work.bucket)) {
      return {
        code: "unavailable",
        message: "Statement staging is unavailable.",
        record: () => Effect.succeed("unavailable" as const),
        respond: () => Effect.succeed(transactionUnavailable()),
      };
    }
    return canonicalStatementRefusal({
      config: { database: work.db, bucket: work.bucket.value, nowEpochMs: () => work.current },
      subject: work.subject,
      current: work.current,
      refusal: statementRefusal("malformed-file"),
    });
  },
};
