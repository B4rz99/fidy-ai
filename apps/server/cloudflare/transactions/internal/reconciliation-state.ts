import { Schema } from "effect";

/** The retained state permitted by the native Reconciliation ledger. */
export const ReconciliationDecisionRow = Schema.Struct({
  state: Schema.Literals(["linked", "keep-separate"]),
});
