import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
import { getCanonicalOperationInput } from "../../../src/shell/canonical-operations/operations";
import type { StatementDecisionWork } from "../contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { StatementSubmission } from "../../../src/shell/ingestion/contract";
import { Cause, Effect, Exit, Option, Schema } from "effect";

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
  submissionProjection,
} from "./statement-staging";
import { statementRefusalResponse } from "./statement-ingestion";
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
        if (Cause.hasInterrupts(result.cause)) return yield* Effect.interrupt;
        result = yield* Effect.exit(read);
      }
      if (Exit.isFailure(result) && Cause.hasInterrupts(result.cause)) {
        return yield* Effect.interrupt;
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
    .prepare(`UPDATE statement_submissions SET hosted_session_id=(SELECT session_id FROM (${origin.sql})),hosted_turn_id=(SELECT turn_id FROM (${origin.sql})),hosted_expires_at_ms=coalesce(hosted_expires_at_ms,(SELECT expires_at_ms FROM (${origin.sql})))
      WHERE id=? AND user_id=? AND EXISTS (SELECT 1 FROM (${origin.sql}) AS proof JOIN (SELECT rowid,id AS turn_id,user_id,document_media_id AS media_id,document_staging_id AS staging_id,document_upload_grant_id AS upload_grant_id,document_upload_expires_at_ms AS upload_expires_at_ms,document_reference_json AS reference_json,started_at_ms AS created_at_ms FROM hosted_turns WHERE document_media_id IS NOT NULL) d ON d.turn_id=proof.turn_id AND d.user_id=proof.user_id WHERE proof.user_id=? AND d.staging_id=? AND (hosted_session_id IS NULL OR (hosted_session_id=proof.session_id AND hosted_turn_id=proof.turn_id)))`)
    .bind(
      ...origin.params,
      ...origin.params,
      ...origin.params,
      submissionId,
      work.userId,
      ...origin.params,
      work.userId,
      stagingId
    ),
  prepareChangedRowAssertion({ db: work.db, scope: "statement_submission" }),
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
