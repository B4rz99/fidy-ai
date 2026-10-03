import { Data, Schema } from "effect";
import { RecurringSeriesConfirmed } from "../../src/core/recurring/contract";
import { UserContext, UserId } from "../../src/core/identity/contract";

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
/** Persistence, malformed retained values and exhausted detection budgets fail closed without content. */
export class RecurringUnavailable extends Data.TaggedError("RecurringUnavailable") {}
