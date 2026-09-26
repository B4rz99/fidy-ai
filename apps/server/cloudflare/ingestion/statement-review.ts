import { Data, DateTime, Effect, Option, Result, Schema } from "effect";
import {
  CapturedFieldIssue,
  StatementNeedsReviewItem,
  StatementRowEvidence,
} from "../../src/core/ingestion/model";
import { currentMillis } from "../pats/pat-shared";
import type { TransactionCaller } from "../transactions/transaction-boundary";
import { commitReadAudit, unavailableStatement, validationFailed } from "./statement-ingestion";

class ReviewReadUnavailable extends Data.TaggedError("ReviewReadUnavailable")<{}> {}

const noStore = { "cache-control": "no-store" };
const evidenceJson = Schema.fromJsonString(StatementRowEvidence);
const issuesJson = Schema.fromJsonString(Schema.Array(CapturedFieldIssue));
const output = Schema.toCodecJson(Schema.Array(StatementNeedsReviewItem));
const pageSize = 50;
const maximumOffset = 10_000;
const ReviewPageOffset = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: maximumOffset })
);

const reviewRow = Schema.Struct({
  id: Schema.String,
  submission_id: Schema.String,
  record_number: Schema.Int,
  reason: Schema.String,
  original_evidence: Schema.NullOr(Schema.String),
  issues: Schema.String,
  status: Schema.String,
  created_at_ms: Schema.Int,
  service_market: Schema.String,
  locale: Schema.String,
  time_zone: Schema.String,
  source_format: Schema.String,
  parser_revision: Schema.String,
  extractor_revision: Schema.String,
});
type ReviewRow = typeof reviewRow.Type;

const projectReviewRow = (row: ReviewRow): Option.Option<StatementNeedsReviewItem> => {
  const issues = Option.getOrUndefined(Schema.decodeOption(issuesJson)(row.issues));
  const evidence =
    typeof row.original_evidence !== "string"
      ? undefined
      : Option.getOrUndefined(Schema.decodeOption(evidenceJson)(row.original_evidence));
  if (issues === undefined || (row.status === "pending" && evidence === undefined)) {
    return Option.none();
  }
  return Schema.decodeUnknownOption(StatementNeedsReviewItem)({
    id: row.id,
    submissionId: row.submission_id,
    recordNumber: row.record_number,
    reason: row.reason,
    serviceMarket: row.service_market,
    locale: row.locale,
    timeZone: row.time_zone,
    sourceFormat: row.source_format,
    sourceChannel: "statement-upload",
    parserRevision: row.parser_revision,
    extractorRevision: row.extractor_revision,
    issues,
    createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.created_at_ms)),
    status: row.status,
    ...(evidence === undefined ? {} : { originalEvidence: evidence }),
  });
};

const reviewPageOffset = (url: URL): Option.Option<number> => {
  const raw = url.searchParams.get("offset") ?? "0";
  return Schema.decodeOption(ReviewPageOffset)(raw);
};

/** A canonical User-scoped read of the persisted, independently expiring review queue. */
export const listStatementNeedsReviewItems = (
  input: Readonly<{
    database: D1Database;
    environment: Parameters<typeof commitReadAudit>[0];
    subject: TransactionCaller;
    url: URL;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const offset = reviewPageOffset(input.url);
    if (Option.isNone(offset)) return validationFailed("Invalid review page offset.");
    const refusal = yield* commitReadAudit(input.environment, input.subject, {
      submissionId: "",
      operation: "ingestion.listNeedsReviewItems",
    });
    if (Option.isSome(refusal)) return refusal.value;

    const asOf = currentMillis();
    const query = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          input.database
            .prepare(`SELECT id, submission_id, record_number, reason,
      CASE WHEN evidence_expires_at_ms > ? THEN original_evidence ELSE NULL END AS original_evidence,
      issues, CASE WHEN evidence_expires_at_ms > ? THEN status ELSE 'expired' END AS status,
      created_at_ms, service_market, locale, time_zone,
      source_format, parser_revision, extractor_revision
      FROM statement_needs_review WHERE user_id = ?
      ORDER BY created_at_ms DESC, id DESC LIMIT ? OFFSET ?`)
            .bind(asOf, asOf, input.subject.userId, pageSize, offset.value)
            .all(),
        catch: () => new ReviewReadUnavailable(),
      })
    );
    if (Result.isFailure(query)) return unavailableStatement();
    const items: Array<StatementNeedsReviewItem> = [];
    for (const raw of query.success.results) {
      const row = Schema.decodeUnknownOption(reviewRow)(raw);
      if (Option.isNone(row)) return unavailableStatement();
      const projected = projectReviewRow(row.value);
      if (Option.isNone(projected)) return unavailableStatement();
      items.push(projected.value);
    }
    const encoded = yield* Effect.result(Schema.encodeEffect(output)(items));
    if (Result.isFailure(encoded)) return unavailableStatement();
    return Response.json({ data: encoded.success, next: [] }, { headers: noStore });
  });
