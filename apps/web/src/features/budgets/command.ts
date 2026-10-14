import { Cause, Effect, Predicate } from "effect";
import type * as Atom from "effect/reactivity/Atom";
import type { CanonicalInput, FidyClient } from "@/transport/client";

type BudgetWrite =
  | Readonly<{ type: "create"; input: CanonicalInput<"budgets.createBudget"> }>
  | Readonly<{ type: "update"; input: CanonicalInput<"budgets.updateBudget"> }>;
type BudgetCommand = BudgetWrite &
  Readonly<{ onSaved: () => void; onRejected: () => void; onUncertain: () => void }>;

/** Dispatch one explicitly requested edit; uncertain writes never replay automatically. */
export const makeBudgetWrite = (
  apiClient: FidyClient
): Atom.AtomResultFn<BudgetCommand, void, never> =>
  apiClient.runtime.fn<BudgetCommand>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        if (command.type === "create") yield* client.budgets.createBudget(command.input);
        else yield* client.budgets.updateBudget(command.input);
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
      ),
    { concurrent: false }
  );
