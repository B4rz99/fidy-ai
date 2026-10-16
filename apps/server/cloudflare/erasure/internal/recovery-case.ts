import { Schema } from "effect";
import { ErasureDecision } from "../../../src/core/erasure/contract";

export const RecoveryCase = Schema.Struct({
  decision: ErasureDecision,
  sealed: Schema.Boolean,
  requestedAtMs: Schema.Int,
  reviewedAtMs: Schema.Int,
  operatorRef: Schema.String,
});
