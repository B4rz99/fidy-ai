import { Schema } from "effect";
import {
  maximumEmailEvidenceIdCharacters,
  maximumResendWebhookDeliveryIdCharacters,
} from "./email-policy";

/** Stable kind code for deterministic tabular statement formats. */
export const StatementSourceFormat = Schema.Literals(["csv", "xlsx"]);
export type StatementSourceFormat = typeof StatementSourceFormat.Type;

/** The only notification-email format interpreted by this direct Colombia launch slice. */
export const EmailSourceFormat = Schema.Literal("notification-email");
export type EmailSourceFormat = typeof EmailSourceFormat.Type;

/** Stable identity of one durable statement submission. */
export const StatementSubmissionId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("StatementSubmissionId"))
  .annotate({ identifier: "StatementSubmissionId" });
export type StatementSubmissionId = typeof StatementSubmissionId.Type;

/** Stable identity of one visible statement row awaiting or retaining resolution metadata. */
export const NeedsReviewItemId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("NeedsReviewItemId"))
  .annotate({ identifier: "NeedsReviewItemId" });
export type NeedsReviewItemId = typeof NeedsReviewItemId.Type;

/** Unpredictable mailbox token for one permanent User forwarding address. */
export const EmailForwardingLocalPart = Schema.String.check(
  Schema.isPattern(/^[a-z0-9_-]{24,64}$/u)
)
  .pipe(Schema.brand("EmailForwardingLocalPart"))
  .annotate({ identifier: "EmailForwardingLocalPart" });
export type EmailForwardingLocalPart = typeof EmailForwardingLocalPart.Type;

/** Stable identity of a User's one permanent forwarded-email address. */
export const EmailForwardingAddressId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("EmailForwardingAddressId"))
  .annotate({ identifier: "EmailForwardingAddressId" });
export type EmailForwardingAddressId = typeof EmailForwardingAddressId.Type;

/** Stable identity of one retained email IngestSample. */
export const IngestSampleId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("IngestSampleId"))
  .annotate({ identifier: "IngestSampleId" });
export type IngestSampleId = typeof IngestSampleId.Type;

/** Resend's stable identity for one received provider email. */
export const ResendReceivedEmailId = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumEmailEvidenceIdCharacters)
).pipe(Schema.brand("ResendReceivedEmailId"));
export type ResendReceivedEmailId = typeof ResendReceivedEmailId.Type;

/** Svix's stable identity for one webhook delivery, used only as replay evidence. */
export const ResendWebhookDeliveryId = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumResendWebhookDeliveryIdCharacters)
).pipe(Schema.brand("ResendWebhookDeliveryId"));
export type ResendWebhookDeliveryId = typeof ResendWebhookDeliveryId.Type;
