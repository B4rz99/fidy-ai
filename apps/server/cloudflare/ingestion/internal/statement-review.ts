import { DateTime, Option, Schema } from "effect";
import {
  EmailNeedsReviewItem,
  NeedsReviewStatus,
  StatementNeedsReviewItem,
} from "../../../src/core/ingestion/contract";

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

export const reviewRow = Schema.Struct({
  id: Schema.String,
  submission_id: Schema.String,
  record_number: Schema.Int,
  reason: Schema.String,
  status: Schema.String,
  transaction_id: Schema.OptionFromNullOr(Schema.String),
  decided_at_ms: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  created_at_ms: Schema.DateTimeUtcFromMillis,
  service_market: Schema.String,
  locale: Schema.String,
  time_zone: Schema.String,
  source_format: Schema.String,
  parser_revision: Schema.String,
  extractor_revision: Schema.String,
});

type ReviewRow = typeof reviewRow.Type;

export const emailReviewRow = Schema.Struct({
  id: Schema.String,
  receipt_id: Schema.String,
  reason: Schema.String,
  created_at_ms: Schema.DateTimeUtcFromMillis,
  evidence_expires_at_ms: Schema.DateTimeUtcFromMillis,
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
    resolvedAt: DateTime.formatIso(row.decided_at_ms.value),
  });
};

export const projectReviewRow = (row: ReviewRow): Option.Option<StatementNeedsReviewItem> =>
  Schema.decodeUnknownOption(StatementNeedsReviewItem)({
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
    issues: [],
    createdAt: DateTime.formatIso(row.created_at_ms),
    status: row.status,
    ...Option.getOrElse(resolutionMetadata(row), () => ({})),
  });

export const projectEmailRow = ({
  row,
  asOf,
}: {
  row: EmailReviewRow;
  asOf: number;
}): Option.Option<EmailNeedsReviewItem> => {
  const expired = row.evidence_expires_at_ms.epochMilliseconds <= asOf;

  const item = {
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
    createdAt: DateTime.formatIso(row.created_at_ms),
    status: expired ? "expired" : "pending",
  };

  return Schema.decodeUnknownOption(EmailNeedsReviewItem)(
    expired || row.reason === "processing-interrupted" || row.reason === "consent-revoked"
      ? item
      : { ...item, ingestSampleId: row.receipt_id }
  );
};

export const reviewPage = (url: URL): Option.Option<typeof ReviewPage.Type> =>
  Schema.decodeUnknownOption(ReviewPage)({
    offset: url.searchParams.get("offset") ?? "0",
    limit: url.searchParams.get("limit") ?? String(pageSize),
    status: url.searchParams.get("status"),
  });
