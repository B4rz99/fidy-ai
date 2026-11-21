import { Data, Schema } from "effect";
import {
  CanonicalCapability,
  CanonicalOperationId,
} from "../../src/core/canonical-operations/contract";

import { maximumAtomicBatchCalls } from "../../src/shell/operations/contract";

const maximumReviewCharacters = 65536;

export const OAuthNativeReview = Schema.Struct({
  reference: Schema.String.check(Schema.isUUID()),
  message: Schema.String.check(Schema.isMaxLength(maximumReviewCharacters)),
  expiresAtMilliseconds: Schema.Int,
});

export type OAuthNativeReview = typeof OAuthNativeReview.Type;

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
