import { DateTime } from "effect";
import { type TransactionFailure } from "~/core/transactions/errors";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import { operationId } from "~/shell/api";

/** What a `TransactionFailure` becomes once it has to leave the process. */
export type TransactionWireFailure = NotFound | ValidationFailed;

/**
 * The slice's one core-to-wire mapper: every `TransactionFailure` becomes the
 * wire failure a caller sees, and this is the only place in `transactions`
 * where an HTTP status, an error code or an agent-facing message is chosen.
 *
 * One per slice rather than one per handler, so a domain failure two operations
 * can raise is answered the same way by both, and a status is never decided
 * twice. The switch is exhaustive over the union: widening `TransactionFailure`
 * without adding a case here fails the build (ARCHITECTURE.md §6).
 */
export const toWireFailure = (failure: TransactionFailure): TransactionWireFailure => {
  switch (failure._tag) {
    case "TransactionNotFound":
      return NotFound.make({
        error: {
          code: "not_found",
          message:
            `No transaction ${failure.transactionId} is in your history. ` +
            `List transactions to see the ids you can ask for.`,
        },
        next: [
          {
            tool: operationId("transactions.listTransactions"),
            hint: "List transactions to find the id you meant.",
          },
        ],
      });

    // A contract-shaped failure that the contract cannot express, because it
    // depends on the clock: it reaches the caller in the same envelope, with
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
              message:
                `Expected an instant no later than ${DateTime.formatIso(failure.now)}, ` +
                `got ${DateTime.formatIso(failure.occurredAt)}`,
            },
          ],
        },
        next: [],
      });
  }
};
