import { hostedStatements } from "./local-statement-scope";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  MediaNeedsReviewItem,
  NeedsReviewItem,
  StatementSubmission,
  type SubmitForExtractionInput,
} from "../../../src/core/ingestion/contract";
import type { UserId } from "../../../src/core/identity/contract";
import { CanonicalAdmissionUnavailable } from "../../canonical-admission/contract";
import {
  decodeOwnedSubmission,
  ownedSubmissionSelection,
  submissionProjection,
} from "./statement-staging";
import {
  type ReviewPage,
  emailReviewRow,
  projectEmailRow,
  projectReviewRow,
  reviewRow,
} from "./statement-review";
import { missing, result } from "./local-review-snapshot";

export const localSubmission = Effect.fn(function* (
  user: UserId,
  id: string,
  hosted: Option.Option<{ turn: string; current: number }> = Option.none()
) {
  const sql = yield* SqliteClient;

  if (Option.isSome(hosted)) {
    const scope = yield* hostedStatements(hosted.value.turn, user, hosted.value.current);

    if ((yield* sql`SELECT 1 WHERE ${id} IN (${scope})`).length === 0) return missing();
  }

  const [raw] = yield* sql.unsafe(ownedSubmissionSelection, [id, user]);

  if (raw === undefined) return missing();
  const found = Option.flatMap(yield* decodeOwnedSubmission(raw), submissionProjection);

  if (Option.isNone(found)) {
    return yield* new CanonicalAdmissionUnavailable({ cause: "statement_projection" });
  }

  return result(yield* Schema.encodeEffect(Schema.toCodecJson(StatementSubmission))(found.value));
});

export const localReviewPage = Effect.fn(function* (
  page: typeof ReviewPage.Type & Partial<{ hostedTurn: string }>,
  user: UserId,
  current: number
) {
  const sql = yield* SqliteClient;
  const status = Option.getOrNull(page.status);

  const origin =
    page.hostedTurn === undefined
      ? sql`1`
      : sql`statement_submission_id IN (${yield* hostedStatements(page.hostedTurn, user, current)})`;

  const rows =
    yield* sql`SELECT * FROM (SELECT id,source_kind,reason,created_at_ms,evidence_expires_at_ms,service_market,locale,time_zone,
    CASE WHEN workspace_state='created' THEN 'resolved' WHEN workspace_state='abandoned' THEN 'abandoned' WHEN evidence_expires_at_ms<=${current} THEN 'expired' ELSE coalesce(workspace_state,'pending') END AS status,
    statement_submission_id AS submission_id,record_number,source_format,parser_revision,extractor_revision,transaction_id,workspace_updated_at_ms AS decided_at_ms,email_receipt_id AS receipt_id,media_submission_id
    FROM ingestion_review_items WHERE user_id=${user} AND (${origin}) AND (source_kind='statement' OR coalesce(workspace_state,'pending')='pending'))
    WHERE (${status} IS NULL OR status=${status}) ORDER BY created_at_ms DESC,id DESC LIMIT ${page.limit} OFFSET ${page.offset}`;

  const items: NeedsReviewItem[] = [];

  yield* Effect.forEach(
    rows,
    Effect.fnUntraced(function* (raw) {
      if (raw.source_kind === "statement") {
        const value = projectReviewRow(yield* Schema.decodeUnknownEffect(reviewRow)(raw));

        if (Option.isNone(value)) {
          return yield* new CanonicalAdmissionUnavailable({ cause: "statement_item" });
        }

        items.push(value.value);
      } else if (raw.source_kind === "email") {
        const value = projectEmailRow({
          row: yield* Schema.decodeUnknownEffect(emailReviewRow)(raw),
          asOf: current,
        });

        if (Option.isNone(value)) {
          return yield* new CanonicalAdmissionUnavailable({ cause: "email_item" });
        }

        items.push(value.value);
      } else {
        items.push(
          yield* Schema.decodeUnknownEffect(MediaNeedsReviewItem)({
            id: raw.id,
            reason: raw.reason,
            createdAt: DateTime.formatIso(DateTime.makeUnsafe(Number(raw.created_at_ms))),
            mediaSubmissionId: raw.media_submission_id,
            serviceMarket: raw.service_market,
            locale: raw.locale,
            timeZone: raw.time_zone,
            sourceChannel: "whatsapp",
            sourceFormat: "image",
            status: raw.status,
          })
        );
      }
    }),
    { discard: true }
  );

  return result(
    yield* Schema.encodeEffect(Schema.toCodecJson(Schema.Array(NeedsReviewItem)))(items)
  );
});

export const observeDocumentPublication = Effect.fn(function* (
  input: SubmitForExtractionInput,
  { user, turn, current }: { user: UserId; turn: Option.Option<string>; current: number }
) {
  if (Option.isNone(turn)) return missing();
  const sql = yield* SqliteClient;
  const { reference, idempotencyKey } = input;
  const scope = yield* hostedStatements(turn.value, user, current);

  const [row] = yield* sql`SELECT s.id FROM statement_submissions s
    JOIN statement_staging_objects m ON m.id=s.staging_id AND m.user_id=s.user_id AND m.published_submission_id=s.id
    JOIN hosted_whatsapp_inbound i ON i.turn_id=s.hosted_turn_id AND i.user_id=s.user_id
    JOIN statement_documents d ON d.id=s.id AND d.user_id=i.user_id AND d.message=i.message AND d.portfolio=i.portfolio AND d.media_id=i.media_id
    WHERE s.id IN (${scope}) AND s.user_id=${user} AND s.hosted_turn_id=${turn.value} AND s.idempotency_key=${idempotencyKey}
    AND m.id=${reference.stagingId} AND m.byte_length=${reference.byteLength} AND m.sha256=${reference.sha256} AND m.expires_at_ms>${current}`;

  if (row === undefined) return missing();
  const id = yield* Schema.decodeUnknownEffect(Schema.String)(row.id);

  return yield* localSubmission(user, id);
});
