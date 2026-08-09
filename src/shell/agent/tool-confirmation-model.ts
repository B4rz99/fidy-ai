import { Schema } from "effect";

/** Cryptographically unique lowercase hexadecimal identity of one exact confirmation challenge. */
export const ConfirmationDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("ConfirmationDigest")
);
/** Cryptographically unique lowercase hexadecimal identity of one exact confirmation challenge. */
export type ConfirmationDigest = typeof ConfirmationDigest.Type;
