import type { EmailReplacementViewState } from "./view";
import { Effect, Option, Predicate, Result, Schema } from "effect";
import type { Atom } from "effect/reactivity";
import {
  EmailAddress,
  type EmailAddress as EmailAddressType,
  EmailReplacementFreshPairingRequiredApi,
  EmailReplacementInvalidApi,
  EmailVerificationCode,
  type FidyClient,
} from "@/transport/client";

type StateCommand = Readonly<{
  onStateChange: (state: EmailReplacementViewState) => void;
}>;
type RequestCommand = StateCommand & Readonly<{ candidateEmail: string }>;
type CompleteCommand = StateCommand &
  Readonly<{ candidateEmail: EmailAddressType; combinedCode: string }>;

type ReplacementCommand<Command> = Readonly<{
  atom: Atom.AtomResultFn<void, void>;
  stage: (command: Command) => void;
  clear: () => void;
}>;

const freshPairingRequired = (failure: unknown): boolean =>
  Schema.is(EmailReplacementFreshPairingRequiredApi)(failure) ||
  Predicate.isTagged(failure, "Unauthenticated");

const makeReplacementCommand = <Command>(
  apiClient: FidyClient,
  work: (command: Command) => Effect.Effect<void>
): ReplacementCommand<Command> => {
  let pending = Option.none<Command>();
  const atom = apiClient.runtime.fn<void>()(
    () =>
      Effect.suspend(() => {
        const offered = pending;
        pending = Option.none();
        return Option.match(offered, { onNone: () => Effect.interrupt, onSome: work });
      }),
    { concurrent: false }
  );
  return {
    atom,
    stage: (command: Command): void => {
      pending = Option.some(command);
    },
    clear: (): void => {
      pending = Option.none();
    },
  };
};

export const makeRequest = ({
  apiClient,
}: Readonly<{ apiClient: FidyClient }>): ReplacementCommand<RequestCommand> =>
  makeReplacementCommand<RequestCommand>(apiClient, ({ candidateEmail, onStateChange }) =>
    Effect.gen(function* () {
      const decoded = Schema.decodeOption(EmailAddress)(candidateEmail);
      if (decoded._tag === "None") {
        yield* Effect.sync(() => onStateChange({ _tag: "Editing" }));
        return;
      }
      yield* Effect.sync(() => onStateChange({ _tag: "Requesting" }));
      const client = yield* apiClient;
      const result = yield* Effect.result(
        client.emailAuthentication.requestEmailReplacement({
          payload: { candidateEmail: decoded.value },
        })
      );
      yield* Effect.sync(() =>
        onStateChange(
          Result.isSuccess(result)
            ? { _tag: "AwaitingCode", candidateEmail: decoded.value }
            : requestFailureState(result.failure)
        )
      );
    })
  );

const requestFailureState = (failure: unknown): EmailReplacementViewState =>
  freshPairingRequired(failure) ? { _tag: "FreshPairingRequired" } : { _tag: "Unavailable" };

export const makeComplete = ({
  apiClient,
}: Readonly<{ apiClient: FidyClient }>): ReplacementCommand<CompleteCommand> =>
  makeReplacementCommand<CompleteCommand>(
    apiClient,
    ({ candidateEmail, combinedCode, onStateChange }) =>
      Effect.gen(function* () {
        const decoded = Schema.decodeOption(EmailVerificationCode)(combinedCode);
        if (decoded._tag === "None") {
          yield* Effect.sync(() => onStateChange({ _tag: "Invalid", candidateEmail }));
          return;
        }
        yield* Effect.sync(() => onStateChange({ _tag: "Completing", candidateEmail }));
        const client = yield* apiClient;
        const result = yield* Effect.result(
          client.emailAuthentication.completeEmailReplacement({
            payload: { combinedCode: decoded.value },
          })
        );
        yield* Effect.sync(() => {
          if (Result.isSuccess(result)) onStateChange({ _tag: "Replaced" });
          else if (freshPairingRequired(result.failure)) {
            onStateChange({ _tag: "FreshPairingRequired" });
          } else if (Schema.is(EmailReplacementInvalidApi)(result.failure)) {
            onStateChange({ _tag: "Invalid", candidateEmail });
          } else onStateChange({ _tag: "Unavailable" });
        });
      })
  );
