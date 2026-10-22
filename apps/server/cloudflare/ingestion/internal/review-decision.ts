import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
import { Option } from "effect";
import { type ReviewMetadata } from "../../../src/core/ingestion/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";

export const writeReviewState = ({
  db,
  userId,
  id,
  status,
  source,
  current,
  guard,
  draft,
  transactionId,
}: Readonly<{
  db: D1Database;
  userId: string;
  id: string;
  status: "pending" | "skipped" | "created";
  source: typeof ReviewMetadata.fields.source.Type;
  current: number;
  guard: OwnedStatement;
  draft: Option.Option<string>;
  transactionId: Option.Option<string>;
}>): D1PreparedStatement =>
  source === "statement"
    ? db
        .prepare(`UPDATE ingestion_review_items SET workspace_state=?,workspace_revision=coalesce(workspace_revision,0)+1,
      draft_json=${Option.isSome(draft) ? "?" : "draft_json"},transaction_id=${Option.isSome(transactionId) ? "?" : "NULL"},workspace_updated_at_ms=?,workspace_archive_row_ref=coalesce(workspace_archive_row_ref,'review:'||id)
      WHERE source_kind='statement' AND id=? AND user_id=? AND EXISTS (${guard.sql})`)
        .bind(
          status,
          ...Option.toArray(draft),
          ...Option.toArray(transactionId),
          current,
          id,
          userId,
          ...guard.params
        )
    : db
        .prepare(`INSERT INTO ingestion_review_state
  (id,user_id,status,revision,draft_json,transaction_id,expires_at_ms,updated_at_ms,created_at_ms)
  SELECT id,user_id,?,revision+1,${Option.isSome(draft) ? "?" : "draft_json"},${Option.isSome(transactionId) ? "?" : "NULL"},expires_at_ms,?,created_at_ms
  FROM ingestion_review_sources WHERE id=? AND user_id=? AND EXISTS (${guard.sql})
  ON CONFLICT(user_id,id) DO UPDATE SET status=excluded.status,revision=excluded.revision,
    draft_json=excluded.draft_json,transaction_id=excluded.transaction_id,updated_at_ms=excluded.updated_at_ms`)
        .bind(
          status,
          ...Option.toArray(draft),
          ...Option.toArray(transactionId),
          current,
          id,
          userId,
          ...guard.params
        );

/** Conversation settlement discards resolved originals; reversible workspace decisions retain their original deadline. */
export const settleStatementReview = ({
  db,
  userId,
  id,
  submissionId,
  current,
  resolved,
}: Readonly<{
  db: D1Database;
  userId: string;
  id: string;
  submissionId: string;
  current: number;
  resolved: boolean;
}>): ReadonlyArray<D1PreparedStatement> => [
  ...(resolved
    ? [
        db
          .prepare(`UPDATE ingestion_review_items SET evidence_state='resolved',original_evidence=NULL,known_money_json=NULL,suggestions_json=NULL
    WHERE source_kind='statement' AND id=? AND user_id=? AND evidence_state='retained'`)
          .bind(id, userId),
        prepareChangedRowAssertion({ db, scope: "ingestion_review" }),
      ]
    : []),
  db
    .prepare(`WITH pending AS MATERIALIZED (
      SELECT EXISTS(SELECT 1 FROM statement_review_context r WHERE r.submission_id=?
        AND NOT EXISTS(SELECT 1 FROM ingestion_review_workspace_state n WHERE n.id=r.id AND n.user_id=r.user_id AND n.status!='pending')) AS remains)
    UPDATE statement_submissions SET
      clarification_state=CASE WHEN (SELECT remains FROM pending) THEN 'awaiting' ELSE 'completed' END,
      clarification_ended_at_ms=CASE WHEN (SELECT remains FROM pending) THEN NULL ELSE ? END
    WHERE id=? AND user_id=? AND clarification_state='awaiting'`)
    .bind(submissionId, current, submissionId, userId),
];
