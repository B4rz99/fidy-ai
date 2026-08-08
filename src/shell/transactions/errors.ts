import { DateTime, Effect, Match, Option } from "effect";
import {
  type InvalidTransactionPeriod,
  type TransactionFailure,
  type TransactionNotFound,
  type TransactionNotYetOccurred,
} from "~/core/transactions/errors";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import {
  type SuggestedOperationCaller,
  checkpointSuggestedOperations,
  suggestOperation,
} from "~/shell/_shared/suggested-operations";

/** What a `TransactionFailure` becomes once it has to leave the process. */
export type TransactionApiFailure = NotFound | ValidationFailed;

const reversedPeriodRejected = (failure: InvalidTransactionPeriod): ValidationFailed =>
  ValidationFailed.make({
    error: {
      code: "validation_failed",
      message: "A transaction period must start before it ends. Correct from or to and retry.",
      fields: [
        {
          path: "from",
          message: `Expected an instant before ${DateTime.formatIso(failure.to)}, got ${DateTime.formatIso(failure.from)}`,
        },
      ],
    },
    next: [],
  });

const unknownTransactionRejected = (
  failure: TransactionNotFound,
  caller: SuggestedOperationCaller
): NotFound =>
  NotFound.make({
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
          args: Option.none(),
          hint: "List transactions to find the id you meant.",
        }),
      ],
      caller,
    }),
  });

const futureMovementRejected = (failure: TransactionNotYetOccurred): ValidationFailed =>
  ValidationFailed.make({
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

type TransactionValidationFailure = InvalidTransactionPeriod | TransactionNotYetOccurred;

type FailureMappingInput<Failure extends TransactionFailure> = {
  readonly failure: Failure;
  readonly caller: SuggestedOperationCaller;
};

function toApiFailure(input: FailureMappingInput<TransactionValidationFailure>): ValidationFailed;
function toApiFailure(input: FailureMappingInput<TransactionFailure>): TransactionApiFailure;
function toApiFailure({
  failure,
  caller,
}: FailureMappingInput<TransactionFailure>): TransactionApiFailure {
  return Match.typeTags<TransactionFailure, TransactionApiFailure>()({
    InvalidTransactionPeriod: reversedPeriodRejected,
    TransactionNotFound: (notFound) => unknownTransactionRejected(notFound, caller),
    // An API-shaped failure the input schema cannot express, because it depends on the clock.
    TransactionNotYetOccurred: futureMovementRejected,
  })(failure);
}

/**
 * Maps a declared Transaction failure to its stable caller-facing API error.
 * Caller facts determine whether any recovery operation may be suggested; the
 * original failure remains in the typed error channel as its corresponding API
 * error.
 */
export const mapTransactionFailure = ({
  caller,
}: {
  readonly caller: SuggestedOperationCaller;
}): (<A, R>(
  self: Effect.Effect<A, TransactionFailure, R>
) => Effect.Effect<A, TransactionApiFailure, R>) =>
  Effect.mapError((failure: TransactionFailure) => toApiFailure({ failure, caller }));

/**
 * Preserves a validation-only error channel for operations that cannot encounter
 * missing Transactions, while delegating all translation to the exhaustive mapper.
 */
export const mapTransactionValidationFailure = ({
  caller,
}: {
  readonly caller: SuggestedOperationCaller;
}): (<A, R>(
  self: Effect.Effect<A, TransactionValidationFailure, R>
) => Effect.Effect<A, ValidationFailed, R>) =>
  Effect.mapError((failure: TransactionValidationFailure) => toApiFailure({ failure, caller }));
