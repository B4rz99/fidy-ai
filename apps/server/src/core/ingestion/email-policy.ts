// Product and evidence bounds shared by the notification-email model, admission policy, and direct
// Resend adapter. Transport-only limits remain at their owning shell boundary.

/** Issue #22 grants each Free User fifty unique notification emails per Bogotá calendar month. */
export const freeForwardedEmailCap = 50;

/** One additional month of Free email can wait without making retained work unbounded. */
export const freeForwardedEmailDeferredCap = 50;

/** Current-month work plus one full deferred month bounds unfinished work for every User. */
export const forwardedEmailOutstandingCap = freeForwardedEmailCap + freeForwardedEmailDeferredCap;

/** Complete metadata and streamed inline-image retrieval must finish within this lease sub-window. */
export const forwardedEmailRetrievalDeadline = "3 minutes";

/** The theoretical local-part, separator, and DNS-name envelope-address maximum is 320 characters. */
export const maximumEmailAddressCharacters = 320;

/** Twenty recipients bounds one provider projection before any User address is resolved. */
export const maximumEmailRecipients = 20;

/** Internet Message Format permits at most 998 content characters on one unfolded line. */
export const maximumEmailSubjectCharacters = 998;

/** Plain text is limited to 256 KiB-equivalent characters before model projection. */
export const maximumEmailTextCharacters = 262_144;

/** HTML is allowed twice the plain-text budget because markup adds structural overhead. */
export const maximumEmailHtmlCharacters = 524_288;

/** Eight one-MiB images cap decoded inline-image bytes at eight MiB per notification email. */
export const maximumEmailInlineImages = 8;

/** Each inline image is bounded independently before Sharp decodes it. */
export const maximumEmailInlineImageBytes = 1_048_576;

/** Width and height are each capped at 4096; their product also bounds decoded pixel allocation. */
export const maximumEmailInlineImageDimension = 4_096;

/** Content and provider message identifiers are bounded metadata, never open-ended evidence. */
export const maximumEmailEvidenceIdCharacters = 256;

/** Svix delivery identifiers are bounded to the replay-ledger column and verification input. */
export const maximumResendWebhookDeliveryIdCharacters = 128;
