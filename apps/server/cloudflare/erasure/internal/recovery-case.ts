import { Schema } from "effect";
import { ErasureReference } from "../../../src/core/erasure/contract";
import { UserId } from "../../../src/core/identity/contract";

export const RecoveryCase = Schema.Struct({
  reference: ErasureReference,
  userId: UserId,
  requestedAtMs: Schema.Int,
  sealed: Schema.Boolean,
});
