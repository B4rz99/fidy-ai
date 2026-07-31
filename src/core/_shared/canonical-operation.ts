import { Schema } from "effect";

/** The canonical operation identity recorded as `<group>.<operation>`. */
export const CanonicalOperationId = Schema.String.check(
  Schema.isPattern(/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/)
).pipe(Schema.brand("CanonicalOperationId"));
export type CanonicalOperationId = typeof CanonicalOperationId.Type;
