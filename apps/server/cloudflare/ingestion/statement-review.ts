import { Data, DateTime, Effect, Option, Result, Schema } from "effect";
import {
  CapturedFieldIssue,
  EmailNeedsReviewItem,
  NeedsReviewItem,
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
const output = Schema.toCodecJson(Schema.Array(NeedsReviewItem));
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
const emailReviewRow = Schema.Struct({
  id: Schema.String,
  receipt_id: Schema.String,
  reason: Schema.String,
  created_at_ms: Schema.Int,
  evidence_expires_at_ms: Schema.Int,
  time_zone: Schema.String,
});
type EmailReviewRow = typeof emailReviewRow.Type;

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

const projectEmailRow = (
  row: EmailReviewRow,
  asOf: number
): Option.Option<EmailNeedsReviewItem> => {
  const expired = row.evidence_expires_at_ms <= asOf;
  return Schema.decodeUnknownOption(EmailNeedsReviewItem)({
    id: row.id,
    receivedEmailId: row.receipt_id,
    reason: row.reason,
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: row.time_zone,
    sourceFormat: "notification-email",
    sourceChannel: "forwarded-email",
    sourceProvider: "cloudflare-email",
    messageEvidence: {
      channel: "email",
      provider: "cloudflare-email",
      providerMessageId: row.receipt_id,
    },
    parserRevision: "cloudflare-mime-v1",
    extractorRevision: "forwarded-email-deterministic-v1",
    issues: [],
    createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.created_at_ms)),
    status: expired ? "expired" : "pending",
    ...(expired || row.reason === "processing-interrupted"
      ? {}
      : { ingestSampleId: row.receipt_id }),
  });
};

// @effect-diagnostics-next-line asyncFunction:off
const loadStatementItems = async (
  database: D1Database,
  userId: string,
  asOf: number
): Promise<Option.Option<ReadonlyArray<NeedsReviewItem>>> => {
  const rows = await database
    .prepare(`SELECT id, submission_id, record_number, reason,
    CASE WHEN evidence_expires_at_ms > ? THEN original_evidence ELSE NULL END AS original_evidence,
    issues, CASE WHEN evidence_expires_at_ms > ? THEN status ELSE 'expired' END AS status,
    created_at_ms, service_market, locale, time_zone,
    source_format, parser_revision, extractor_revision
    FROM statement_needs_review WHERE user_id = ?
    ORDER BY created_at_ms DESC, id DESC LIMIT ?`)
    .bind(asOf, asOf, userId, maximumOffset + pageSize)
    .all();
  const items: Array<NeedsReviewItem> = [];
  for (const raw of rows.results) {
    const row = Schema.decodeUnknownOption(reviewRow)(raw);
    if (Option.isNone(row)) return Option.none();
    const item = projectReviewRow(row.value);
    if (Option.isNone(item)) return Option.none();
    items.push(item.value);
  }
  return Option.some(items);
};

// @effect-diagnostics-next-line asyncFunction:off
const loadEmailItems = async (
  database: D1Database,
  userId: string,
  asOf: number
): Promise<Option.Option<ReadonlyArray<NeedsReviewItem>>> => {
  const rows = await database
    .prepare(`SELECT e.id, e.receipt_id, e.reason,
    e.created_at_ms, e.evidence_expires_at_ms, r.time_zone FROM forwarded_email_needs_review e
    JOIN forwarded_email_receipts r ON r.id = e.receipt_id AND r.user_id = e.user_id
    WHERE e.user_id = ? ORDER BY e.created_at_ms DESC, e.id DESC LIMIT ?`)
    .bind(userId, maximumOffset + pageSize)
    .all();
  const items: Array<NeedsReviewItem> = [];
  for (const raw of rows.results) {
    const row = Schema.decodeUnknownOption(emailReviewRow)(raw);
    if (Option.isNone(row)) return Option.none();
    const item = projectEmailRow(row.value, asOf);
    if (Option.isNone(item)) return Option.none();
    items.push(item.value);
  }
  return Option.some(items);
};

const reviewPageOffset = (url: URL): Option.Option<number> =>
  Schema.decodeOption(ReviewPageOffset)(url.searchParams.get("offset") ?? "0");

/** A canonical User-scoped read of persisted, independently expiring review outcomes. */
export const listNeedsReviewItems = (
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
    const loaded = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          Promise.all([
            loadStatementItems(input.database, input.subject.userId, asOf),
            loadEmailItems(input.database, input.subject.userId, asOf),
          ]),
        catch: () => new ReviewReadUnavailable(),
      })
    );
    if (Result.isFailure(loaded)) return unavailableStatement();
    const [statement, email] = loaded.success;
    if (Option.isNone(statement) || Option.isNone(email)) return unavailableStatement();
    const items = [...statement.value, ...email.value];
    items.sort(
      (left, right) =>
        DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt)
    );
    const encoded = yield* Effect.result(
      Schema.encodeEffect(output)(items.slice(offset.value, offset.value + pageSize))
    );
    if (Result.isFailure(encoded)) return unavailableStatement();
    return Response.json({ data: encoded.success, next: [] }, { headers: noStore });
  });
