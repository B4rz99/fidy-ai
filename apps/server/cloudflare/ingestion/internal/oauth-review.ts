import { type Cause, Effect, Option, Schema } from "effect";
import type { OAuthMutationReview } from "../../oauth-confirmation/contract";
import { Hex } from "effect/encoding";
import { IngestionGroup } from "../../../src/shell/ingestion/contract";
import { TransactionExtraction } from "../../../src/core/transactions/contract";
import { getOperationPolicy } from "../../../src/shell/canonical-policy/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { type TransactionCaller, isOAuthCaller } from "../../canonical-work/operations";
import { oauthMutationReview } from "../../oauth-confirmation/operations";
import { digestBytes } from "../../secret-material/operations";
import type { StatementClarificationOperation } from "./clarification-operation";

const maximumReviewRows = 5000;
const NullableText = Schema.NullOr(Schema.String);
const NullableInstant = Schema.NullOr(Schema.Int);
const ReviewSnapshot = Schema.Struct({
  id: Schema.String,
  record_number: Schema.Int,
  reason: Schema.String,
  original_evidence: NullableText,
  known_money: NullableText,
  issues: Schema.String,
  status: Schema.Literals(["pending", "expired", "resolved"]),
  evidence_expires_at_ms: Schema.Int,
  created_at_ms: Schema.Int,
  service_market: Schema.Literal("CO"),
  locale: Schema.Literal("es-CO"),
  time_zone: Schema.String,
  source_format: Schema.Literals(["csv", "xlsx"]),
  parser_revision: Schema.String,
  extractor_revision: Schema.String,
});
const Snapshot = Schema.Struct({
  submission: Schema.Struct({
    id: Schema.String,
    staging_id: Schema.String,
    source_format: Schema.Literals(["csv", "xlsx"]),
    parser_revision: Schema.String,
    status: Schema.Literals(["queued", "processing", "completed", "failed"]),
    accepted_rows: NullableInstant,
    needs_review_rows: NullableInstant,
  }),
  clarification: Schema.Struct({
    state: Schema.Literals(["awaiting", "completed", "abandoned"]),
    expires_at_ms: Schema.Int,
    ended_at_ms: NullableInstant,
  }),
  content: Schema.Struct({ sha256: Schema.String, status: Schema.String }),
  entitlement: Schema.NullOr(
    Schema.Struct({
      submission_id: NullableText,
      consumed_at_ms: NullableInstant,
    })
  ),
  reviews: Schema.Array(ReviewSnapshot).check(Schema.isMaxLength(maximumReviewRows)),
  decisions: Schema.Array(
    Schema.Struct({
      review_id: Schema.String,
      decision: Schema.Literals(["resolved", "skipped", "abandoned"]),
      transaction_id: NullableText,
      decided_at_ms: Schema.Int,
    })
  ).check(Schema.isMaxLength(maximumReviewRows)),
});
const StoredSnapshot = Schema.Struct({ snapshot: Schema.String });

// All names are fixed owner columns. The same ordered projection is read and compared at commit.
const snapshotSql = `SELECT json_object(
  'submission', json_object('id',s.id,'staging_id',s.staging_id,'source_format',s.source_format,
    'parser_revision',s.parser_revision,'status',s.status,'accepted_rows',s.accepted_rows,'needs_review_rows',s.needs_review_rows),
  'clarification', json_object('state',c.state,'expires_at_ms',c.expires_at_ms,'ended_at_ms',c.ended_at_ms),
  'content', json_object('sha256',o.sha256,'status',o.status),
  'entitlement', (SELECT json_object('submission_id',e.submission_id,'consumed_at_ms',e.consumed_at_ms)
    FROM statement_backfill_entitlements e WHERE e.user_id=s.user_id),
  'reviews', (SELECT json_group_array(json_object('id',id,'record_number',record_number,'reason',reason,
    'original_evidence',original_evidence,'known_money',known_money,'issues',issues,'status',status,
    'evidence_expires_at_ms',evidence_expires_at_ms,'created_at_ms',created_at_ms,'service_market',service_market,
    'locale',locale,'time_zone',time_zone,'source_format',source_format,'parser_revision',parser_revision,
    'extractor_revision',extractor_revision)) FROM (SELECT * FROM statement_needs_review
      WHERE submission_id=s.id AND user_id=s.user_id ORDER BY id LIMIT 5001)),
  'decisions', (SELECT json_group_array(json_object('review_id',review_id,'decision',decision,
    'transaction_id',transaction_id,'decided_at_ms',decided_at_ms)) FROM (SELECT * FROM statement_review_decisions
      WHERE submission_id=s.id AND user_id=s.user_id ORDER BY review_id LIMIT 5001))
  ) AS snapshot FROM statement_submissions s
  JOIN statement_clarifications c ON c.submission_id=s.id AND c.user_id=s.user_id
  JOIN statement_staging_objects o ON o.id=s.staging_id AND o.user_id=s.user_id
  WHERE s.id=? AND s.user_id=?`;

export const needsOAuthReview = (
  input: Readonly<{ subject: TransactionCaller; operation: StatementClarificationOperation }>
): boolean => {
  const { subject, operation } = input;
  if (!isOAuthCaller(subject)) return false;
  switch (operation) {
    case "ingestion.resolveNeedsReviewItem":
      return (
        getOperationPolicy(IngestionGroup.endpoints.resolveNeedsReviewItem).agentConfirmation ===
        "required"
      );
    case "ingestion.skipNeedsReviewItem":
      return (
        getOperationPolicy(IngestionGroup.endpoints.skipNeedsReviewItem).agentConfirmation ===
        "required"
      );
    case "ingestion.abandonStatementSubmission":
      return (
        getOperationPolicy(IngestionGroup.endpoints.abandonStatementSubmission)
          .agentConfirmation === "required"
      );
  }
};

type ReviewInput = Readonly<{
  db: D1Database;
  userId: string;
  submissionId: string;
  operation: StatementClarificationOperation;
  reviewId: Option.Option<string>;
  extraction: Option.Option<TransactionExtraction>;
}>;
const reserveState = (snapshot: typeof Snapshot.Type, submissionId: string): string => {
  if (snapshot.entitlement === null || snapshot.entitlement.submission_id !== submissionId) {
    return "no asociada";
  }
  return snapshot.entitlement.consumed_at_ms === null ? "sin consumir" : "consumida";
};
const exactEffect = (input: ReviewInput, snapshot: typeof Snapshot.Type): string => {
  const undecided = snapshot.reviews.filter(
    (row) => !snapshot.decisions.some((decision) => decision.review_id === row.id)
  );
  const rows = undecided
    .map((row) => `${row.id} (fila ${row.record_number}, estado ${row.status})`)
    .join(", ");
  const target = Option.match(input.reviewId, {
    onNone: () => rows,
    onSome: (id) => {
      const row = snapshot.reviews.find((value) => value.id === id);
      return row === undefined ? id : `${id} (fila ${row.record_number}, estado ${row.status})`;
    },
  });
  let effect: string;
  switch (input.operation) {
    case "ingestion.resolveNeedsReviewItem":
      effect = `Resolver ${target} del envío ${input.submissionId}: crear una Transacción y su SourceAttestation con estos datos exactos: ${Option.match(input.extraction, { onNone: () => "sin datos", onSome: Schema.encodeSync(Schema.fromJsonString(TransactionExtraction)) })}; borrar la evidencia original y el Money conocido de esa fila. La primera captura consume la reserva gratuita, si existe.`;
      break;
    case "ingestion.skipNeedsReviewItem":
      effect = `Omitir ${target} del envío ${input.submissionId} sin crear una Transacción; borrar permanentemente su evidencia original y Money conocido.`;
      break;
    case "ingestion.abandonStatementSubmission":
      effect = `Abandonar permanentemente el envío ${input.submissionId}: omitir las ${undecided.length} filas restantes (${rows}) y borrar su evidencia original y Money conocido; conservar las ${snapshot.submission.accepted_rows ?? 0} capturas de extracción y las ${snapshot.decisions.filter((decision) => decision.decision === "resolved").length} Transacciones de aclaración ya creadas.`;
  }
  return (
    effect +
    ` Al decidir la última fila, finalizar la aclaración. Una reserva gratuita sin capturas se libera; una ya consumida se conserva. Estado actual de la reserva: ${reserveState(snapshot, input.submissionId)}.`
  );
};

/** Observe the exact aggregate that settlement may erase or complete, without minting new identities. */
export const clarificationOAuthReview = (
  input: ReviewInput
): Effect.Effect<
  Readonly<{
    guard: OwnedStatement;
    review: OAuthMutationReview;
  }>,
  Schema.SchemaError | Cause.UnknownError | Effect.Error<ReturnType<typeof digestBytes>>
> =>
  Effect.gen(function* () {
    const stored = yield* Effect.tryPromise(() =>
      input.db.prepare(snapshotSql).bind(input.submissionId, input.userId).first()
    );
    const encoded = yield* Schema.decodeUnknownEffect(StoredSnapshot)(stored);
    const snapshot = yield* Schema.decodeEffect(Schema.fromJsonString(Snapshot))(encoded.snapshot);
    const guard: OwnedStatement = {
      sql: `SELECT 1 WHERE (${snapshotSql}) = ?`,
      params: [input.submissionId, input.userId, encoded.snapshot],
    };
    return {
      guard,
      review: oauthMutationReview({
        db: input.db,
        effect: exactEffect(input, snapshot),
        revision: Hex.encode(yield* digestBytes(new TextEncoder().encode(encoded.snapshot))),
        guard,
      }),
    };
  });
