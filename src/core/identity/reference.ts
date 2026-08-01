import { Schema } from "effect";

/**
 * The identity every slice references when it needs to say whose data this is.
 *
 * A stable surrogate id independent of channel identities and credentials.
 * WhatsAppIdentity belongs to the identity slice's own record, so changing a
 * phone number does not rewrite every table that points at the same User.
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
