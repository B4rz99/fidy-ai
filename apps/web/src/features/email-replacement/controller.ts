import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Effect, Option, Predicate, Result, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import {
  EmailAddress,
  type EmailAddress as EmailAddressType,
  EmailReplacementFreshPairingRequiredApi,
  EmailReplacementInvalidApi,
  EmailVerificationCode,
  type FidyClient,
} from "@/transport/client";

/** Renderable states for the transient verified-email replacement interaction. */
export type EmailReplacementViewState =
  | Readonly<{ _tag: "Editing" }>
  | Readonly<{ _tag: "Requesting" }>
  | Readonly<{ _tag: "AwaitingCode"; candidateEmail: EmailAddressType }>
  | Readonly<{ _tag: "Completing"; candidateEmail: EmailAddressType }>
  | Readonly<{ _tag: "Invalid"; candidateEmail: EmailAddressType }>
  | Readonly<{ _tag: "FreshPairingRequired" }>
  | Readonly<{ _tag: "Replaced" }>
  | Readonly<{ _tag: "Unavailable" }>;

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

const makeRequest = (apiClient: FidyClient): ReplacementCommand<RequestCommand> =>
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

const makeComplete = (apiClient: FidyClient): ReplacementCommand<CompleteCommand> =>
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

type EmailReplacementController = Readonly<{
  state: EmailReplacementViewState;
  request: (candidateEmail: string) => void;
  complete: (candidateEmail: EmailAddressType, combinedCode: string) => void;
  restart: () => void;
}>;

/** Owns transient replacement form state and dispatches typed request/completion commands. */
export const useEmailReplacement = (): EmailReplacementController => {
  const router = useRouter();
  const [state, setState] = useState<EmailReplacementViewState>({ _tag: "Editing" });
  const [requestAtom] = useState(() => makeRequest(router.options.context.apiClient));
  const [completeAtom] = useState(() => makeComplete(router.options.context.apiClient));
  const request = useAtomSet(requestAtom.atom);
  const complete = useAtomSet(completeAtom.atom);
  return {
    state,
    request: (candidateEmail: string): void => {
      requestAtom.stage({ candidateEmail, onStateChange: setState });
      request(undefined);
    },
    complete: (candidateEmail: EmailAddressType, combinedCode: string): void => {
      completeAtom.stage({ candidateEmail, combinedCode, onStateChange: setState });
      complete(undefined);
    },
    restart: (): void => {
      requestAtom.clear();
      completeAtom.clear();
      request(Atom.Interrupt);
      complete(Atom.Interrupt);
      setState({ _tag: "Editing" });
    },
  } as const;
};
