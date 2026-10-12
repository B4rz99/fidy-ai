import { Cause, Effect, Predicate } from "effect";
import type * as Atom from "effect/reactivity/Atom";
import type { CanonicalInput, FidyClient } from "@/transport/client";
import type { Transaction } from "./presentation";

type CorrectionCommand = Readonly<{
  changes: CanonicalInput<"transactions.updateTransaction">["payload"]["changes"];
  onSaved: () => void;
  onRejected: () => void;
  onUncertain: () => void;
}>;
export const makeTransactionCorrection = ({
  apiClient,
  transaction,
}: Readonly<{
  apiClient: FidyClient;
  transaction: Pick<Transaction, "id" | "revision">;
}>): Atom.AtomResultFn<CorrectionCommand, void, never> =>
  apiClient.runtime.fn<CorrectionCommand>()((command) =>
    Effect.gen(function* () {
      const client = yield* apiClient;
      yield* client.transactions.updateTransaction({
        params: { id: transaction.id },
        payload: { expectedRevision: transaction.revision, changes: command.changes },
      });
      yield* Effect.sync(command.onSaved);
    }).pipe(
      Effect.catch((failure) =>
        Effect.sync(
          Predicate.isTagged(failure, "ValidationFailed") ||
            Predicate.isTagged(failure, "NotFound") ||
            Predicate.isTagged(failure, "ResourceLimited")
            ? command.onRejected
            : command.onUncertain
        )
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.sync(command.onUncertain)
      )
    )
  );
