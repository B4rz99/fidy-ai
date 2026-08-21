import { Schema } from "effect";

/** Stable identity of one User-authorized Personal Access Token grant. */
export const PATId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PATId"))
  .annotate({ identifier: "PATId" });
export type PATId = typeof PATId.Type;
