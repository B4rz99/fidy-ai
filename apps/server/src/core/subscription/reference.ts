import { Schema } from "effect";

/** Stable identity of one immutable set of Subscription price terms. */
export const PriceId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PriceId"))
  .annotate({ identifier: "PriceId" });
export type PriceId = typeof PriceId.Type;
