import { Data, Schema } from "effect";
import {
  CanonicalCapability,
  CanonicalOperationId,
} from "../../src/core/canonical-operations/contract";

import { maximumAtomicBatchCalls } from "../../src/shell/operations/contract";
import type { OAuthConfirmationAttempt } from "../../src/shell/mcp/contract";

const maximumReviewCharacters = 65536;

/** The complete original canonical invocation accompanies every native continuation. */
export type OAuthConfirmationWork = Readonly<{
  operation: CanonicalOperationId;
  input: Schema.Json;
  attempt: OAuthConfirmationAttempt;
}>;

/** Owner-observed effect and revision; its guards must assert that same snapshot before writing. */
export type OAuthMutationReview = Readonly<{
  effect: string;
  revision: string;
  guards: ReadonlyArray<D1PreparedStatement>;
}>;

/** Public continuation state binds work, not authority or human presence. */
export const OAuthNativeReview = Schema.Struct({
  reference: Schema.String.check(Schema.isUUID()),
  message: Schema.String.check(Schema.isMaxLength(maximumReviewCharacters)),
  expiresAtMilliseconds: Schema.Int,
});
export type OAuthNativeReview = typeof OAuthNativeReview.Type;

/** Ordered prepared effects and original scope requirements, including ordinary batch children. */
export const OAuthReviewBinding = Schema.Array(
  Schema.Struct({
    operation: CanonicalOperationId,
    scope: Schema.NullOr(CanonicalCapability),
    effect: Schema.String,
    revision: Schema.String,
  })
).check(Schema.isBetweenLength(1, maximumAtomicBatchCalls));
export type OAuthReviewBinding = typeof OAuthReviewBinding.Type;

export class OAuthConfirmationRetentionUnavailable extends Data.TaggedError(
  "OAuthConfirmationRetentionUnavailable"
) {}
