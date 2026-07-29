import { DateTime, Effect } from "effect";
import { type TransactionFailure } from "~/core/transactions/errors";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import {
  checkpointSuggestedOperations,
  type SuggestedOperationCaller,
  suggestOperation,
} from "~/shell/_shared/suggested-operations";

/** What a `TransactionFailure` becomes once it has to leave the process. */
export type TransactionApiFailure = NotFound | ValidationFailed;

const toApiFailure = ({
  failure,
  caller,
}: {
  readonly failure: TransactionFailure;
  readonly caller: SuggestedOperationCaller;
}): TransactionApiFailure => {
  switch (failure._tag) {
    case "TransactionNotFound":
      return NotFound.make({
        error: {
          code: "not_found",
          message:
            `No transaction ${failure.transactionId} is in your history. ` +
            `List transactions to see the ids you can ask for.`,
        },
        next: checkpointSuggestedOperations({
          candidates: [
            suggestOperation({
              tool: "transactions.listTransactions",
              hint: "List transactions to find the id you meant.",
            }),
          ],
          caller,
        }),
      });

    // An API-shaped failure that the input schema cannot express, because it
    // depends on the clock: it reaches the caller in the same response, with
    // the same code, as one the gate caught.
    case "TransactionNotYetOccurred":
      return ValidationFailed.make({
        error: {
          code: "validation_failed",
          message:
            `A transaction records money that has already moved. ` +
            `Send an occurredAt at or before ${DateTime.formatIso(failure.now)} and retry.`,
          fields: [
            {
              path: "occurredAt",
              message: `Expected an instant no later than ${DateTime.formatIso(failure.now)}`,
            },
          ],
        },
        next: [],
      });
  }
};

/**
 * Maps a declared Transaction failure to its stable caller-facing API error.
 * Caller facts determine whether any recovery operation may be suggested; the
 * original failure remains in the typed error channel as its corresponding API
 * error.
 */
export const mapTransactionFailure = ({ caller }: { readonly caller: SuggestedOperationCaller }) =>
  Effect.mapError((failure: TransactionFailure) => toApiFailure({ failure, caller }));
