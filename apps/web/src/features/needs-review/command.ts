import { Cause, Effect, Predicate } from "effect";
import type { Atom } from "effect/reactivity";
import type { FidyClient } from "@/transport/client";
import type { Command, Detail } from "./model";

export type ReviewWrite = Readonly<{
  command: Command;
  saved: (items: ReadonlyArray<Detail>) => void;
  failed: (uncertain: boolean) => void;
}>;
export const makeReviewWrite = (
  apiClient: FidyClient
): Atom.AtomResultFn<ReviewWrite, void, never> =>
  apiClient.runtime.fn<ReviewWrite>()(
    (input) =>
      Effect.gen(function* () {
        const result = yield* applyCommand(apiClient, input.command);
        yield* Effect.sync(() => input.saved(result.data));
      }).pipe(
        Effect.catch((failure) =>
          Effect.sync(() => input.failed(!Predicate.isTagged(failure, "ValidationFailed")))
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.sync(() => input.failed(true))
        )
      ),
    { concurrent: false, reactivityKeys: ["ingestion-review"] }
  );

const applyCommand = Effect.fnUntraced(function* (apiClient: FidyClient, command: Command) {
  const client = yield* apiClient;
  switch (command._tag) {
    case "Create":
      return yield* client.ingestion.applyReviewEdit({ payload: command });
    case "SaveDraft":
      return yield* client.ingestion.applyReviewEdit({ payload: command });
    case "Skip":
      return yield* client.ingestion.applyReviewEdit({ payload: command });
    case "Restore":
      return yield* client.ingestion.applyReviewEdit({ payload: command });
  }
});
