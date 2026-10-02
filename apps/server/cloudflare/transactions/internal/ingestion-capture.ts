import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  NotificationEmailSourceAttestation,
  NotificationInterpretationEvidence,
  encodeMoneyAmount,
} from "../../../src/core/transactions/contract";
import { prepareConsentAction } from "../../consent/operations";
import type { NotificationEmailCaptureInput, StatementCaptureInput } from "../contract";

const sourceAuthority = ({
  userId,
  sourceGuard,
}: Pick<StatementCaptureInput, "userId" | "sourceGuard">): OwnedStatement => ({
  sql: `EXISTS (SELECT 1 FROM (${sourceGuard.sql}) capture_source WHERE capture_source.user_id = ?)`,
  params: [...sourceGuard.params, userId],
});

const transactionStatement = (
  input: StatementCaptureInput | NotificationEmailCaptureInput,
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

// The persisted deterministic evidence retains its original embedded interpretation revision.
const interpretationCodec = Schema.fromJsonString(
  Schema.Struct({
    ...NotificationInterpretationEvidence.fields,
    revision: NotificationEmailSourceAttestation.fields.interpretationRevision,
  })
);
const messageCodec = Schema.fromJsonString(
  NotificationEmailSourceAttestation.fields.messageEvidence
);

/**
 * Prepare one notification-email Transaction and its immutable evidence for the caller's outcome
 * batch under the User coordinator. Both writes require current Consent and the same User's live
 * source eligibility at commit. Provider and deterministic evidence retain their captured revision;
 * malformed evidence fails before any write. Category assignment remains the caller's decision.
 */
export const prepareNotificationEmailCapture = (
  input: NotificationEmailCaptureInput
): Effect.Effect<ReadonlyArray<D1PreparedStatement>, Schema.SchemaError> =>
  Effect.gen(function* () {
    const { db, userId, transactionId, attestation } = input;
    const guard = sourceAuthority(input);
    const evidence = yield* Schema.encodeUnknownEffect(interpretationCodec)({
      ...input.interpretation,
      revision: attestation.interpretationRevision,
    });
    const messageEvidence = yield* Schema.encodeUnknownEffect(messageCodec)(
      attestation.messageEvidence
    );
    return [
      prepareConsentAction({
        db,
        subject: { _tag: "User", userId },
        requirement: "active",
        statement: transactionStatement(input, attestation.createdAt),
      }),
      prepareConsentAction({
        db,
        subject: { _tag: "User", userId },
        requirement: "active",
        statement: {
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
        },
      }),
    ];
  });
