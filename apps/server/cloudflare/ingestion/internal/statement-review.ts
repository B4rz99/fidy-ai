import { Data, DateTime, Effect, Option, Result, Schema } from "effect";
import {
  CapturedFieldIssue,
  EmailNeedsReviewItem,
  NeedsReviewItem,
  NeedsReviewStatus,
  StatementNeedsReviewItem,
  StatementRowEvidence,
} from "../../../src/core/ingestion/contract";
import { loadMediaItems } from "./media-review";
import { currentMillis } from "../../runtime/operations";
import type { QueryCaller } from "../../canonical-work/operations";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { commitReadAudit, unavailableStatement, validationFailed } from "./statement-ingestion";

class ReviewReadUnavailable extends Data.TaggedError("ReviewReadUnavailable")<{}> {}

const noStore = { "cache-control": "no-store" };
const evidenceJson = Schema.fromJsonString(StatementRowEvidence);
const issuesJson = Schema.fromJsonString(Schema.Array(CapturedFieldIssue));
const output = Schema.toCodecJson(Schema.Array(NeedsReviewItem));
export const pageSize = 50;
const maximumOffset = 10_000;
export const ReviewPage = Schema.Struct({
  offset: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: maximumOffset })
  ),
  limit: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 100 })
  ),
  status: Schema.OptionFromNullOr(NeedsReviewStatus),
});
const reviewRow = Schema.Struct({
  id: Schema.String,
  submission_id: Schema.String,
  record_number: Schema.Int,
  reason: Schema.String,
  original_evidence: Schema.NullOr(Schema.String),
  issues: Schema.String,
  status: Schema.String,
  transaction_id: Schema.OptionFromNullOr(Schema.String),
  decided_at_ms: Schema.OptionFromNullOr(Schema.Int),
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

const resolutionMetadata = (
  row: ReviewRow
): Option.Option<Readonly<{ transactionId: string; resolvedAt: string }>> => {
  if (
    row.status !== "resolved" ||
    Option.isNone(row.transaction_id) ||
    Option.isNone(row.decided_at_ms)
  ) {
    return Option.none();
  }
  return Option.some({
    transactionId: row.transaction_id.value,
    resolvedAt: DateTime.formatIso(DateTime.makeUnsafe(row.decided_at_ms.value)),
  });
};

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
    ...Option.getOrElse(resolutionMetadata(row), () => ({})),
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
    ...(expired || row.reason === "processing-interrupted" || row.reason === "consent-revoked"
      ? {}
      : { ingestSampleId: row.receipt_id }),
  });
};

export const loadStatementItems = ({
  database,
  userId,
  asOf,
  scope,
  status,
}: Readonly<{
  database: D1Database;
  userId: string;
  asOf: number;
  scope: Option.Option<OwnedStatement>;
  status: Option.Option<typeof NeedsReviewStatus.Type>;
}>): Effect.Effect<Option.Option<ReadonlyArray<StatementNeedsReviewItem>>, ReviewReadUnavailable> =>
  Effect.gen(function* () {
    const guard = Option.getOrElse(scope, () => ({ sql: "1 = 1", params: [] }));
    const rows = yield* Effect.tryPromise({
      try: () =>
        database
          .prepare(`SELECT * FROM (SELECT r.id, r.submission_id, r.record_number, r.reason,
    CASE WHEN r.evidence_expires_at_ms > ? AND c.state = 'awaiting' AND c.expires_at_ms > ? THEN r.original_evidence ELSE NULL END AS original_evidence,
    r.issues, coalesce(d.decision, CASE WHEN c.state = 'abandoned' OR c.expires_at_ms <= ? THEN 'abandoned'
      WHEN r.evidence_expires_at_ms > ? THEN r.status ELSE 'expired' END) AS status,
    d.transaction_id, d.decided_at_ms, r.created_at_ms, r.service_market, r.locale, r.time_zone,
    r.source_format, r.parser_revision, r.extractor_revision
    FROM statement_needs_review r LEFT JOIN statement_review_decisions d ON d.review_id = r.id
    LEFT JOIN statement_clarifications c ON c.submission_id = r.submission_id
    WHERE r.user_id = ? AND (${guard.sql})
    ) AS projected WHERE (? IS NULL OR status = ?)
    ORDER BY created_at_ms DESC, id DESC LIMIT ?`)
          .bind(
            asOf,
            asOf,
            asOf,
            asOf,
            userId,
            ...guard.params,
            Option.getOrNull(status),
            Option.getOrNull(status),
            maximumOffset + pageSize
          )
          .all(),
      catch: () => new ReviewReadUnavailable(),
    });
    const items: Array<StatementNeedsReviewItem> = [];
    for (const raw of rows.results) {
      const row = Schema.decodeUnknownOption(reviewRow)(raw);
      if (Option.isNone(row)) return Option.none();
      const item = projectReviewRow(row.value);
      if (Option.isNone(item)) return Option.none();
      items.push(item.value);
    }
    return Option.some(items);
  });

const loadEmailItems = (
  database: D1Database,
  userId: string,
  asOf: number
): Effect.Effect<Option.Option<ReadonlyArray<NeedsReviewItem>>, ReviewReadUnavailable> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise({
      try: () =>
        database
          .prepare(`SELECT e.id, e.receipt_id, e.reason,
    e.created_at_ms, e.evidence_expires_at_ms, r.time_zone FROM forwarded_email_needs_review e
    JOIN forwarded_email_receipts r ON r.id = e.receipt_id AND r.user_id = e.user_id
    WHERE e.user_id = ? ORDER BY e.created_at_ms DESC, e.id DESC LIMIT ?`)
          .bind(userId, maximumOffset + pageSize)
          .all(),
      catch: () => new ReviewReadUnavailable(),
    });
    const items: Array<NeedsReviewItem> = [];
    for (const raw of rows.results) {
      const row = Schema.decodeUnknownOption(emailReviewRow)(raw);
      if (Option.isNone(row)) return Option.none();
      const item = projectEmailRow(row.value, asOf);
      if (Option.isNone(item)) return Option.none();
      items.push(item.value);
    }
    return Option.some(items);
  });

const reviewPage = (url: URL): Option.Option<typeof ReviewPage.Type> =>
  Schema.decodeUnknownOption(ReviewPage)({
    offset: url.searchParams.get("offset") ?? "0",
    limit: url.searchParams.get("limit") ?? String(pageSize),
    status: url.searchParams.get("status"),
  });

/** Filter before slicing so settled rows cannot trap a pending clarification page. */
export const selectReviewPage = ({
  items,
  page,
}: Readonly<{
  items: ReadonlyArray<NeedsReviewItem>;
  page: typeof ReviewPage.Type;
}>): ReadonlyArray<NeedsReviewItem> =>
  items
    .filter(({ status }) => Option.isNone(page.status) || Option.contains(page.status, status))
    .slice(page.offset, page.offset + page.limit);

/** A canonical User-scoped read of persisted, independently expiring review outcomes. */
export const listNeedsReviewItems = (
  input: Readonly<{
    database: D1Database;
    environment: Parameters<typeof commitReadAudit>[0];
    subject: QueryCaller;
    url: URL;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const page = reviewPage(input.url);
    if (Option.isNone(page)) return validationFailed("Invalid review page.");
    const refusal = yield* commitReadAudit(input.environment, input.subject, {
      submissionId: "",
      operation: "ingestion.listNeedsReviewItems",
    });
    if (Option.isSome(refusal)) return refusal.value;
    return yield* readCanonicalReviewPage({
      database: input.database,
      userId: input.subject.userId,
      asOf: currentMillis(),
      scope: Option.none(),
      includeEmail: true,
      page: page.value,
    });
  });

// Tool results can outlive settlement; row evidence remains solely in its purpose-bound owner.
const statementReviewMetadata = (item: StatementNeedsReviewItem): StatementNeedsReviewItem => ({
  ...item,
  knownMoney: Option.none(),
  issues: [],
  ...(item.status === "pending" ? { originalEvidence: Option.none() } : {}),
});

/** One canonical review query; transport adapters supply already checked authority and paging. */
export const readCanonicalReviewPage = (
  input: Readonly<{
    database: D1Database;
    userId: string;
    asOf: number;
    scope: Option.Option<OwnedStatement>;
    includeEmail: boolean;
    page: typeof ReviewPage.Type;
  }>
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const { asOf } = input;
    const loaded = yield* Effect.result(
      Effect.all(
        [
          loadStatementItems({
            database: input.database,
            userId: input.userId,
            asOf,
            scope: input.scope,
            status: input.page.status,
          }),
          input.includeEmail
            ? loadEmailItems(input.database, input.userId, asOf)
            : Effect.succeedSome([]),
          input.includeEmail
            ? loadMediaItems({
                db: input.database,
                userId: input.userId,
                asOf,
                limit: maximumOffset + pageSize,
              })
            : Effect.succeedSome([]),
        ],
        { concurrency: "unbounded" }
      )
    );
    if (Result.isFailure(loaded)) return unavailableStatement();
    const [statement, email, media] = loaded.success;
    if (Option.isNone(statement) || Option.isNone(email) || Option.isNone(media)) {
      return unavailableStatement();
    }
    const statements = statement.value.map(statementReviewMetadata);
    const items = [...statements, ...email.value, ...media.value];
    items.sort(
      (left, right) =>
        DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt)
    );
    const encoded = yield* Effect.result(
      Schema.encodeEffect(output)(selectReviewPage({ items, page: input.page }))
    );
    if (Result.isFailure(encoded)) return unavailableStatement();
    return Response.json({ data: encoded.success, next: [] }, { headers: noStore });
  });
