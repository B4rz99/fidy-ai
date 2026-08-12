import { Schema } from "effect";

/** Assigned once at capture and stable independently of later Reconciliation. */
export const TransactionId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("TransactionId"))
  .annotate({ identifier: "TransactionId" });
export type TransactionId = typeof TransactionId.Type;
