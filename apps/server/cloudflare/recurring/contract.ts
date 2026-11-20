import { Data, Schema } from "effect";
import {
  RecurringConfirmationId,
  RecurringSeriesConfirmed,
} from "../../src/core/recurring/contract";
import { UserContext, UserId } from "../../src/core/identity/contract";
import { UtcTimestamp } from "../../src/core/_shared/time";

export const RecurringWork = Schema.Struct({ userId: UserId });

export const RecurringConfirmation = Schema.Struct({
  userId: UserId,
  context: UserContext,
  occurrence: RecurringSeriesConfirmed,
});
export type RecurringConfirmation = typeof RecurringConfirmation.Type;

export const RecurringConfirmationPage = Schema.Struct({
  confirmations: Schema.Array(RecurringConfirmation),
  cursor: Schema.OptionFromOptionalKey(Schema.String),
});
export type RecurringConfirmationPage = typeof RecurringConfirmationPage.Type;

export const maximumDigestCheckpointLength = 1024;

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

export class RecurringUnavailable extends Data.TaggedError("RecurringUnavailable") {}

export const recurringDiscoveryIntervalMs = 3_600_000;
