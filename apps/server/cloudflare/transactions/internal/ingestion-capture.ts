import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { DateTime, Effect, Option, Schema } from "effect";
import { NotificationEmailSourceAttestation } from "../../../src/core/source-attestation/contract";
import { NotificationInterpretationEvidence } from "../../../src/core/transactions/contract";
import { encodeMoneyAmount } from "../../../src/core/_shared/money";
import { prepareConsentAction, prepareQueuedConsentAction } from "../../consent/operations";
import type {
  NotificationEmailCaptureInput,
  ReviewedCaptureInput,
  StatementCaptureInput,
} from "../contract";

const sourceAuthority = ({
  userId,
  sourceGuard,
}: Pick<StatementCaptureInput, "userId" | "sourceGuard">): OwnedStatement => ({
  sql: `EXISTS (SELECT 1 FROM (${sourceGuard.sql}) capture_source WHERE capture_source.user_id = ?)`,
  params: [...sourceGuard.params, userId],
});

const transactionStatement = (
  input: StatementCaptureInput | NotificationEmailCaptureInput | ReviewedCaptureInput,
  createdAt: string
): OwnedStatement => {
  const { extraction, userId, transactionId, categoryId } = input;
  const guard = sourceAuthority(input);
  return {
    sql: `INSERT INTO transactions (id, user_id, amount, currency,
      direction, counterparty, category_id, notes, occurred_at, created_at)
      SELECT ?, ?, ?, ?, ?, ${Option.isSome(extraction.counterparty) ? "?" : "NULL"}, ?, NULL, ?, ?
      WHERE ${guard.sql}`,
    params: [
      transactionId,
      userId,
      encodeMoneyAmount(extraction.money.amount),
      extraction.money.currency,
      extraction.direction,
      ...Option.toArray(extraction.counterparty),
      categoryId,
      DateTime.formatIso(extraction.occurredAt),
      createdAt,
      ...guard.params,
    ],
  };
};

/**
 * Prepare one statement Transaction and its captured historical SourceAttestation. The caller
 * holds the User coordinator and commits both writes with its unique record outcome and assertion
 * in the same D1 batch. Preparation performs no effects; each write rechecks the source owner's
 * complete eligibility query for this explicit User. Category assignment and admission Consent
 * remain with the caller. Retained evidence never substitutes current User preferences.
 */
export const prepareStatementCapture = (
  input: StatementCaptureInput
): ReadonlyArray<D1PreparedStatement> => {
  const { db, userId, transactionId, attestation } = input;
  const guard = sourceAuthority(input);
  const transaction = transactionStatement(input, attestation.createdAt);
  return [
    db.prepare(transaction.sql).bind(...transaction.params),
    db
      .prepare(`INSERT INTO source_attestations (id, user_id, transaction_id,
        kind, service_market, locale, time_zone, interpretation_revision, created_at,
        statement_submission_id, statement_record_number, statement_content_hash, source_format)
        SELECT ?, ?, ?, 'statement-line', ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`)
      .bind(
        attestation.id,
        userId,
        transactionId,
        attestation.serviceMarket,
        attestation.locale,
        attestation.timeZone,
        attestation.interpretationRevision,
        attestation.createdAt,
        attestation.statementSubmissionId,
        attestation.statementRecordNumber,
        attestation.statementContentHash,
        attestation.sourceFormat,
        ...guard.params
      ),
  ];
};

const interpretationCodec = Schema.fromJsonString(
  Schema.Struct({
    ...NotificationInterpretationEvidence.fields,
    revision: NotificationEmailSourceAttestation.fields.interpretationRevision,
  })
);
const messageCodec = Schema.fromJsonString(
  NotificationEmailSourceAttestation.fields.messageEvidence
);

const prepareEmailAction = (
  input: NotificationEmailCaptureInput,
  statement: OwnedStatement
): D1PreparedStatement =>
  Option.match(input.queuedAdmission, {
    onNone: () =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement,
      }),
    onSome: (queued) =>
      prepareQueuedConsentAction({ db: input.db, userId: input.userId, queued, statement }),
  });

/**
 * Prepare one notification-email Transaction and its immutable evidence for the caller's outcome
 * batch under the User coordinator. Both writes recheck same-User source eligibility at commit.
 * Without queuedAdmission they require current Consent; continuation instead rechecks the caller's
 * exact unfinished, unexpired native queue item and historical Consent. The caller must prove its
 * admission under active Consent. Evidence retains its captured revision; malformed evidence fails
 * before any write. Category assignment remains the caller's decision.
 */
export const prepareNotificationEmailCapture = (
  input: NotificationEmailCaptureInput
): Effect.Effect<ReadonlyArray<D1PreparedStatement>, Schema.SchemaError> =>
  Effect.gen(function* () {
    const { userId, transactionId, attestation } = input;
    const guard = sourceAuthority(input);
    const evidence = yield* Schema.encodeUnknownEffect(interpretationCodec)({
      ...input.interpretation,
      revision: attestation.interpretationRevision,
    });
    const messageEvidence = yield* Schema.encodeUnknownEffect(messageCodec)(
      attestation.messageEvidence
    );
    return [
      prepareEmailAction(input, transactionStatement(input, attestation.createdAt)),
      prepareEmailAction(input, {
        sql: `INSERT INTO source_attestations
            (id, user_id, transaction_id, kind, service_market, locale, time_zone,
             interpretation_revision, created_at, received_email_id, message_content_sha256,
             source_format, message_evidence, deterministic_interpretation, extractor_revision)
            SELECT ?, ?, ?, 'notification-email', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
        params: [
          attestation.id,
          userId,
          transactionId,
          attestation.serviceMarket,
          attestation.locale,
          attestation.timeZone,
          attestation.interpretationRevision,
          attestation.createdAt,
          attestation.receivedEmailId,
          attestation.messageContentSha256,
          attestation.sourceFormat,
          messageEvidence,
          evidence,
          attestation.extractorRevision,
          ...guard.params,
        ],
      }),
    ];
  });

/** A review decision is manual capture; its source context and all User-supplied facts stay explicit. */
export const prepareReviewedCapture = (
  input: ReviewedCaptureInput
): ReadonlyArray<D1PreparedStatement> => {
  const transaction = transactionStatement(input, input.createdAt);
  const guard = sourceAuthority(input);
  return [
    input.db.prepare(transaction.sql).bind(...transaction.params),
    input.db
      .prepare(`INSERT INTO source_attestations
      (id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,created_at,review_item_id,user_provided_fields)
      SELECT ?,?,?,'manual',?,?,?,'user-reviewed-v1',?,?,? WHERE ${guard.sql}`)
      .bind(
        input.attestationId,
        input.userId,
        input.transactionId,
        input.context.serviceMarket,
        input.context.locale,
        input.context.timeZone,
        input.createdAt,
        input.reviewItemId,
        Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
          input.userProvidedFields
        ),
        ...guard.params
      ),
  ];
};
