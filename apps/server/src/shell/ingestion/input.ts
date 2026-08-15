import { Schema } from "effect";
import { TransactionExtraction } from "~/core/transactions/model";

/** Canonical Transaction facts supplied to resolve one pending statement row. */
export const ResolveNeedsReviewItemInput = Schema.Struct({
  extraction: TransactionExtraction,
}).annotate({ identifier: "ResolveNeedsReviewItemInput" });
export type ResolveNeedsReviewItemInput = typeof ResolveNeedsReviewItemInput.Type;
