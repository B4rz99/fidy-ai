import { Cause, Effect, Predicate } from "effect";
import type * as Atom from "effect/reactivity/Atom";
import type { CanonicalInput, FidyClient } from "@/transport/client";

export type RecurringWrite = Readonly<{
  input: CanonicalInput<"recurringPlans.applyRecurringEdit">;
  onSaved: () => void;
  onRejected: () => void;
  onUncertain: () => void;
}>;
export const makeRecurringWrite = (
  apiClient: FidyClient
): Atom.AtomResultFn<RecurringWrite, void, never> =>
  apiClient.runtime.fn<RecurringWrite>()(
    (command) =>
      Effect.gen(function* () {
        const client = yield* apiClient;
        yield* client.recurringPlans.applyRecurringEdit(command.input);
        yield* Effect.sync(command.onSaved);
      }).pipe(
        Effect.catch((failure) =>
          Effect.sync(
            Predicate.isTagged(failure, "ValidationFailed")
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
