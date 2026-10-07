import { Data, Schema } from "effect";
import {
  RecurringConfirmationId,
  RecurringSeriesConfirmed,
} from "../../src/core/recurring/contract";
import { UserContext, UserId } from "../../src/core/identity/contract";
import { UtcTimestamp } from "../../src/core/_shared/time";

/** Metadata-only coordinator request; the identity must match the existing DO's stable User. */
export const RecurringWork = Schema.Struct({ userId: UserId });
/** Historical meaning retained with the explicit subject of a durable confirmation. */
export const RecurringConfirmation = Schema.Struct({
  userId: UserId,
  context: UserContext,
  occurrence: RecurringSeriesConfirmed,
});
export type RecurringConfirmation = typeof RecurringConfirmation.Type;
/** One bounded consumer page; the cursor is a position in the same User's confirmation history. */
export const RecurringConfirmationPage = Schema.Struct({
  confirmations: Schema.Array(RecurringConfirmation),
  cursor: Schema.OptionFromOptionalKey(Schema.String),
});
export type RecurringConfirmationPage = typeof RecurringConfirmationPage.Type;

export const maximumDigestCheckpointLength = 1024;
/** Complete traversal includes invalidation and permanent legacy exclusion, without inventing missing historical facts. */
export const RecurringDigestSourcePage = Schema.Struct({
  confirmations: Schema.Array(
    Schema.Struct({
      id: RecurringConfirmationId,
      confirmedAt: UtcTimestamp,
      context: UserContext,
      valid: Schema.Boolean,
      snapshot: Schema.Option(RecurringConfirmation),
    })
  ),
  sourceIdentity: Schema.String.check(Schema.isMaxLength(maximumDigestCheckpointLength)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  checkpoint: Schema.String.check(Schema.isMaxLength(maximumDigestCheckpointLength)),
  cutoffAt: UtcTimestamp,
  complete: Schema.Boolean,
  cursor: Schema.Option(Schema.String.check(Schema.isMaxLength(maximumDigestCheckpointLength))),
});
export type RecurringDigestSourcePage = typeof RecurringDigestSourcePage.Type;
/** Persistence, malformed retained values and exhausted detection budgets fail closed without content. */
export class RecurringUnavailable extends Data.TaggedError("RecurringUnavailable") {}
