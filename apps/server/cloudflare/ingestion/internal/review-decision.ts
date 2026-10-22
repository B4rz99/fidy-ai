import { prepareChangedRowAssertion } from "../../../src/shell/sql-assertions/operations";
import { Option } from "effect";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";

export const writeReviewState = ({
  db,
  userId,
  id,
  status,
  current,
  guard,
  draft,
  transactionId,
}: Readonly<{
  db: D1Database;
  userId: string;
  id: string;
  status: "pending" | "skipped" | "created";
  current: number;
  guard: OwnedStatement;
  draft: Option.Option<string>;
  transactionId: Option.Option<string>;
}>): D1PreparedStatement =>
  db
    .prepare(`UPDATE ingestion_review_items SET workspace_state=?,workspace_revision=coalesce(workspace_revision,0)+1,
      draft_json=${Option.isSome(draft) ? "?" : "draft_json"},transaction_id=${Option.isSome(transactionId) ? "?" : "NULL"},workspace_updated_at_ms=?,workspace_archive_row_ref=coalesce(workspace_archive_row_ref,'review:'||id)
      WHERE id=? AND user_id=? AND EXISTS (${guard.sql})`)
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
