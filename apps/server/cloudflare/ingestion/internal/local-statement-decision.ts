import { hostedStatements } from "./local-statement-scope";
import { localClarificationReview } from "./oauth-review";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import { UserContext, type UserId } from "../../../src/core/identity/contract";
import type { TransactionExtraction } from "../../../src/core/transactions/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { ConsentSubject } from "../../../src/shell/consent/contract";
import { prepareSourcedCapture } from "../../transactions/operations";
import { prepareLocalWrite } from "../../canonical-admission/operations";
import { CanonicalAdmissionUnavailable } from "../../canonical-admission/contract";
import { missing } from "./local-review-snapshot";
import { localSubmission } from "./local-review-list";

const selected = Schema.Struct({
  ...UserContext.fields,
  id: Schema.String,
  record: Schema.Int,
  format: Schema.String,
  sha: Schema.String,
  revision: Schema.String,
});

type DecisionOwner = Readonly<{
  user: UserId;
  current: number;
  origin: Option.Option<{ sessionId: string; turnId: string }>;
  requiresOrigin: boolean;
}>;

const eligible = Effect.fn(function* (
  id: string,
  { user, current, origin, requiresOrigin }: DecisionOwner
) {
  const sql = yield* SqliteClient;

  if (requiresOrigin && Option.isNone(origin)) return false;

  const predicate = Option.isSome(origin)
    ? "hosted_session_id=? AND hosted_turn_id=? AND hosted_abandoned_at_ms IS NULL AND hosted_expires_at_ms>?"
    : "hosted_session_id IS NULL";

  const bindings = Option.isSome(origin)
    ? [origin.value.sessionId, origin.value.turnId, current]
    : [];

  const guard = protectConsentStatement({
    subject: ConsentSubject.User({ userId: user }),
    requirement: "active",
    statement: {
      sql: `SELECT id FROM statement_submissions WHERE user_id=? AND id=? AND clarification_state='awaiting' AND clarification_expires_at_ms>? AND (${predicate})`,
      params: [user, id, current, ...bindings],
    },
  });

  return (yield* sql.unsafe(guard.sql, guard.params)).length === 1;
});

export const prepareLocalAbandon = Effect.fn(function* (id: string, owner: DecisionOwner) {
  const sql = yield* SqliteClient;
  const { user, current } = owner;

  if (!(yield* eligible(id, owner))) return missing();

  return prepareLocalWrite({
    targets: ["statement:" + id],
    review: localClarificationReview({
      userId: user,
      submissionId: id,
      operation: "ingestion.abandonStatementSubmission",
      reviewId: Option.none(),
      extraction: Option.none(),
    }),
    commit: Effect.gen(function* () {
      yield* sql`UPDATE ingestion_review_items SET workspace_state='abandoned',workspace_revision=coalesce(workspace_revision,0)+1,workspace_updated_at_ms=${current},workspace_archive_row_ref=coalesce(workspace_archive_row_ref,'review:'||id),draft_json=NULL,suggestions_json=NULL,original_evidence=NULL,evidence_state='expired',known_money_json=NULL WHERE user_id=${user} AND statement_submission_id=${id} AND coalesce(workspace_state,'pending')='pending'`;
      yield* sql`UPDATE statement_submissions SET clarification_state='abandoned',clarification_ended_at_ms=${current} WHERE id=${id} AND user_id=${user}`;
      yield* sql`DELETE FROM statement_backfill WHERE user_id=${user} AND submission_id=${id} AND consumed_at_ms IS NULL`;

      return yield* localSubmission(user, id);
    }),
  });
});

const selectReview = Effect.fn(function* (user: UserId, id: string, current: number) {
  const sql = yield* SqliteClient;

  const [raw] =
    yield* sql`SELECT r.statement_submission_id AS id,r.record_number AS record,r.source_format AS format,r.parser_revision AS revision,r.service_market AS serviceMarket,r.locale,r.time_zone AS timeZone,m.sha256 AS sha
    FROM ingestion_review_items r JOIN statement_submissions s ON s.id=r.statement_submission_id AND s.user_id=r.user_id JOIN statement_staging_objects m ON m.id=s.staging_id AND m.user_id=s.user_id WHERE r.user_id=${user} AND r.id=${id} AND r.evidence_state='retained' AND coalesce(r.workspace_state,'pending')='pending' AND r.evidence_expires_at_ms>${current}`;

  return raw;
});

const capturedId = Schema.Struct({ data: Schema.Struct({ id: Schema.String }) });

const reviewedLineCapture = Effect.fn(function* (
  row: typeof selected.Type,
  { user, current }: DecisionOwner,
  extraction: Option.Option<TransactionExtraction>
) {
  return yield* Effect.transposeOption(
    Option.map(extraction, (value) =>
      prepareSourcedCapture(
        { ...value, categoryId: Option.none(), notes: Option.none() },
        { userId: user, current },

        {
          kind: "statement-line",
          context: row,
          revision: row.revision,
          submissionId: row.id,
          recordNumber: row.record,
          sha256: row.sha,
          format: row.format,
        }
      )
    )
  );
});

export const prepareLocalDecision = Effect.fn(function* (
  id: string,
  extraction: Option.Option<TransactionExtraction>,
  owner: DecisionOwner
) {
  const sql = yield* SqliteClient;
  const { user, current } = owner;
  const raw = yield* selectReview(user, id, current);

  if (raw === undefined) return missing();
  const row = yield* Schema.decodeUnknownEffect(selected)(raw);

  if (!(yield* eligible(row.id, owner))) return missing();
  const capture = yield* reviewedLineCapture(row, owner, extraction);

  if (Option.isSome(capture) && !("commit" in capture.value)) return capture.value;

  return prepareLocalWrite({
    targets: ["review:" + id],
    review: localClarificationReview({
      userId: user,
      submissionId: row.id,
      operation: Option.isSome(extraction)
        ? "ingestion.resolveNeedsReviewItem"
        : "ingestion.skipNeedsReviewItem",
      reviewId: Option.some(id),
      extraction,
    }),
    commit: Effect.gen(function* () {
      const response =
        Option.isSome(capture) && "commit" in capture.value
          ? Option.some(yield* capture.value.commit)
          : Option.none();

      const tx = Option.isSome(response)
        ? (yield* Schema.decodeUnknownEffect(capturedId)(response.value.body)).data.id
        : null;

      const changed =
        yield* sql`UPDATE ingestion_review_items SET workspace_state=${tx === null ? "skipped" : "created"},workspace_revision=coalesce(workspace_revision,0)+1,workspace_updated_at_ms=${current},workspace_archive_row_ref=coalesce(workspace_archive_row_ref,'review:'||id),draft_json=NULL,suggestions_json=NULL,original_evidence=NULL,evidence_state='resolved',known_money_json=NULL,transaction_id=${tx}
    WHERE id=${id} AND user_id=${user} AND coalesce(workspace_state,'pending')='pending' RETURNING id`;

      if (changed.length !== 1) {
        return yield* new CanonicalAdmissionUnavailable({ cause: "statement_decision" });
      }

      if (tx !== null) {
        yield* sql`UPDATE statement_backfill SET consumed_at_ms=coalesce(consumed_at_ms,${current}) WHERE user_id=${user} AND submission_id=${row.id}`;
      }

      yield* sql`UPDATE statement_submissions SET clarification_state='completed',clarification_ended_at_ms=${current} WHERE id=${row.id} AND user_id=${user} AND NOT EXISTS(SELECT 1 FROM ingestion_review_items WHERE statement_submission_id=${row.id} AND coalesce(workspace_state,'pending')='pending')`;
      yield* sql`DELETE FROM statement_backfill WHERE user_id=${user} AND submission_id=${row.id} AND consumed_at_ms IS NULL AND EXISTS(SELECT 1 FROM statement_submissions WHERE id=${row.id} AND clarification_state='completed')`;

      return Option.isSome(response)
        ? { ...response.value, status: 200 }
        : yield* localSubmission(user, row.id);
    }),
    premises: ["statement:" + row.id],
  });
});

export const resolveOrigin = Effect.fn(function* (active: string, target: string, user: UserId) {
  const sql = yield* SqliteClient;
  const scope = yield* hostedStatements(active, user, yield* Clock.currentTimeMillis);

  const [row] =
    yield* sql`SELECT s.hosted_session_id AS sessionId,s.hosted_turn_id AS turnId FROM statement_submissions s
    WHERE s.id IN (${scope}) AND (s.id=${target} OR EXISTS(SELECT 1 FROM ingestion_review_items i WHERE i.id=${target} AND i.user_id=s.user_id AND i.statement_submission_id=s.id))`;

  return Option.flatMap(
    Option.fromUndefinedOr(row),
    Schema.decodeUnknownOption(Schema.Struct({ sessionId: Schema.String, turnId: Schema.String }))
  );
});
