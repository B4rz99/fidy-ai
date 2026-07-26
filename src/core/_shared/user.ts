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
