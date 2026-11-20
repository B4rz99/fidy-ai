import { Schema } from "effect";

export const ReconciliationDecisionRow = Schema.Struct({
  state: Schema.Literals(["linked", "keep-separate"]),
});
