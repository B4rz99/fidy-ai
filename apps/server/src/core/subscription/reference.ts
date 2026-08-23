import { Schema } from "effect";

/** Stable identity of one immutable set of Subscription price terms. */
export const PriceRevisionId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PriceRevisionId"))
  .annotate({ identifier: "PriceRevisionId" });
export type PriceRevisionId = typeof PriceRevisionId.Type;
