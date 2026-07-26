import { Schema } from "effect";

/**
 * The identity every slice references when it needs to say whose data this is.
 *
 * A surrogate id, not the WhatsApp phone number that CONTEXT.md calls the root
 * identifier: the phone number belongs to the identity slice's own record, and
 * a number that changes hands must not rewrite every table that points at it.
 *
 * Ownership is context, not a field (ARCHITECTURE.md §5), so this appears in
 * repo and core signatures and in storage — never as a field on an ordinary
 * entity's schema, where a client could name it.
 */
export const UserId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;
