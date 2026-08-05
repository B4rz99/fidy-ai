import { Schema } from "effect";

/**
 * The identity every slice references when it needs to say whose data this is.
 *
 * A stable surrogate id independent of channel identities and credentials.
 * WhatsAppIdentity belongs to the identity slice's own record, so changing a
 * BSUID, phone number, or username does not rewrite tables that point at the same User.
 *
 * Ownership is context, not a field (ARCHITECTURE.md §5), so this appears in
 * repo and core signatures and in storage — never as a field on an ordinary
 * entity's schema, where a client could name it.
 */
export const UserId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

/**
 * A WhatsApp phone number in canonical E.164 form: one leading `+`, a
 * non-zero country-code digit, and 8–15 digits total. Formatting characters
 * and locally scoped numbers are rejected so database uniqueness has one
 * spelling per number.
 */
export const E164PhoneNumber = Schema.String.check(Schema.isPattern(/^\+[1-9][0-9]{7,14}$/)).pipe(
  Schema.brand("E164PhoneNumber")
);
export type E164PhoneNumber = typeof E164PhoneNumber.Type;

/**
 * Trimmed, non-empty Meta Business Portfolio identifier, limited to 128 characters. It scopes
 * every BSUID and must come from trusted deployment configuration rather than webhook payloads.
 */
export const WhatsAppBusinessPortfolioId = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(128)
).pipe(Schema.brand("WhatsAppBusinessPortfolioId"));
export type WhatsAppBusinessPortfolioId = typeof WhatsAppBusinessPortfolioId.Type;

/**
 * Meta's stable WhatsApp caller key within one Business Portfolio. Accepted values consist of a
 * two-letter market prefix, a dot, and 1–128 alphanumeric characters.
 */
export const WhatsAppBusinessScopedUserId = Schema.String.check(
  Schema.isPattern(/^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/iu)
).pipe(Schema.brand("WhatsAppBusinessScopedUserId"));
export type WhatsAppBusinessScopedUserId = typeof WhatsAppBusinessScopedUserId.Type;

/**
 * Optional cross-portfolio evidence available only to enrolled managed businesses. It follows
 * Meta's two-letter market, `.ENT.`, and 1–128 alphanumeric identifier format and never resolves a
 * Fidy User.
 */
export const WhatsAppParentBusinessScopedUserId = Schema.String.check(
  Schema.isPattern(/^[A-Z]{2}\.ENT\.[A-Za-z0-9]{1,128}$/iu)
).pipe(Schema.brand("WhatsAppParentBusinessScopedUserId"));
export type WhatsAppParentBusinessScopedUserId = typeof WhatsAppParentBusinessScopedUserId.Type;

/**
 * Trimmed, non-empty WhatsApp username of at most 256 characters. It is mutable display evidence
 * and never caller-resolution authority.
 */
export const WhatsAppUsername = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(256)
).pipe(Schema.brand("WhatsAppUsername"));
export type WhatsAppUsername = typeof WhatsAppUsername.Type;

/** Stable cross-slice reference to one WhatsApp caller within a trusted Business Portfolio. */
export const WhatsAppCallerReference = Schema.Struct({
  businessPortfolioId: WhatsAppBusinessPortfolioId,
  businessScopedUserId: WhatsAppBusinessScopedUserId,
}).annotate({ identifier: "WhatsAppCallerReference" });
export type WhatsAppCallerReference = typeof WhatsAppCallerReference.Type;

/** Projects a caller-like value to the stable reference safe for cross-slice use. */
export const whatsAppCallerReference = (
  caller: Readonly<WhatsAppCallerReference>
): WhatsAppCallerReference => ({
  businessPortfolioId: caller.businessPortfolioId,
  businessScopedUserId: caller.businessScopedUserId,
});
