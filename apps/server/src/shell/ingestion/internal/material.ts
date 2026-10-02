import { DateTime, Schema } from "effect";
import { ServiceMarket } from "~/core/_shared/context";
import {
  CapturedInterpretationContext,
  InterpretationRevision,
} from "~/core/interpretation-evidence/contract";
import { UtcTimestamp } from "~/core/_shared/time";
import {
  EmailSourceFormat,
  IngestSampleId,
  ReceivedEmailId,
  StatementSourceFormat,
} from "~/core/ingestion/reference";
import {
  maximumEmailAddressCharacters,
  maximumEmailEvidenceIdCharacters,
  maximumEmailHtmlCharacters,
  maximumEmailInlineImages,
  maximumEmailRecipients,
  maximumEmailSubjectCharacters,
  maximumEmailTextCharacters,
} from "~/core/ingestion/contract";

const maximumMappingSampleRows = 5;

/** Bounded inline image bytes referenced from received HTML; ordinary attachments are excluded. */
export const ReceivedInlineImage = Schema.Struct({
  contentId: Schema.NonEmptyString.check(
    Schema.isTrimmed(),
    Schema.isMaxLength(maximumEmailEvidenceIdCharacters)
  ),
  mediaType: Schema.Literals(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  content: Schema.Uint8Array,
});
export type ReceivedInlineImage = typeof ReceivedInlineImage.Type;

/** Closed Email Worker projection retained as raw personal evidence for a configured 90 days. */
export const ReceivedEmailContent = Schema.Struct({
  receivedEmailId: ReceivedEmailId,
  from: Schema.String.check(Schema.isMaxLength(maximumEmailAddressCharacters)),
  to: Schema.Array(Schema.String.check(Schema.isMaxLength(maximumEmailAddressCharacters))).check(
    Schema.isMaxLength(maximumEmailRecipients)
  ),
  subject: Schema.String.check(Schema.isMaxLength(maximumEmailSubjectCharacters)),
  text: Schema.OptionFromOptionalKey(
    Schema.String.check(Schema.isMaxLength(maximumEmailTextCharacters))
  ),
  html: Schema.OptionFromOptionalKey(
    Schema.String.check(Schema.isMaxLength(maximumEmailHtmlCharacters))
  ),
  inlineImages: Schema.Array(ReceivedInlineImage).check(
    Schema.isMaxLength(maximumEmailInlineImages)
  ),
  messageId: Schema.OptionFromOptionalKey(
    Schema.String.check(Schema.isMaxLength(maximumEmailEvidenceIdCharacters))
  ),
  createdAt: UtcTimestamp,
}).annotate({ identifier: "ReceivedEmailContent" });
export type ReceivedEmailContent = typeof ReceivedEmailContent.Type;

const RawEmailIngestSampleFields = Schema.Struct({
  id: IngestSampleId,
  receivedEmailId: ReceivedEmailId,
  ...CapturedInterpretationContext.fields,
  sourceFormat: EmailSourceFormat,
  sourceProvider: Schema.Literal("cloudflare-email"),
  parserRevision: InterpretationRevision,
  content: ReceivedEmailContent,
  retainedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
});
const validRawEmailRetention = Schema.makeFilter<
  Readonly<Pick<typeof RawEmailIngestSampleFields.Type, "retainedAt" | "expiresAt">>
>((sample) =>
  DateTime.toEpochMillis(sample.retainedAt) < DateTime.toEpochMillis(sample.expiresAt)
    ? undefined
    : { path: ["expiresAt"], issue: "Expected expiry after retention" }
);

/** Raw personal IngestSample retained only until its explicit expiry. */
export const RawEmailIngestSample = RawEmailIngestSampleFields.check(
  validRawEmailRetention
).annotate({ identifier: "RawEmailIngestSample" });
export type RawEmailIngestSample = typeof RawEmailIngestSample.Type;

/** Operator-approved, User-unlinked structural evidence eligible for indefinite retention. */
export const AnonymizedEmailIngestSample = Schema.Struct({
  id: IngestSampleId,
  serviceMarket: ServiceMarket,
  sourceFormat: EmailSourceFormat,
  sourceProvider: Schema.Literal("cloudflare-email"),
  parserRevision: InterpretationRevision,
  anonymizationRevision: InterpretationRevision,
  structure: Schema.NonEmptyString,
  approvedAt: UtcTimestamp,
  retainedAt: UtcTimestamp,
}).annotate({ identifier: "AnonymizedEmailIngestSample" });
export type AnonymizedEmailIngestSample = typeof AnonymizedEmailIngestSample.Type;

/** Raw headers and at most five raw rows sent once to map an unknown statement format. */
export const StatementMappingSample = Schema.Struct({
  sourceFormat: StatementSourceFormat,
  headers: Schema.NonEmptyArray(Schema.String),
  sampleRows: Schema.Array(Schema.Array(Schema.String)).check(
    Schema.isMaxLength(maximumMappingSampleRows)
  ),
});
export type StatementMappingSample = typeof StatementMappingSample.Type;
