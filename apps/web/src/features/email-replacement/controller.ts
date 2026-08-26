import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Effect, Result, Schema } from "effect";
import type { Atom } from "effect/unstable/reactivity";
import { useState } from "react";
import {
  EmailAddress,
  type EmailAddress as EmailAddressType,
  EmailReplacementFreshPairingRequiredApi,
  type FidyClient,
  type WebAuthClient,
} from "@/transport/client";

/** Renderable states for the transient verified-email replacement interaction. */
export type EmailReplacementViewState =
  | Readonly<{ _tag: "Editing" }>
  | Readonly<{ _tag: "Requesting" }>
  | Readonly<{ _tag: "AwaitingCode"; candidateEmail: EmailAddressType }>
  | Readonly<{ _tag: "Completing"; candidateEmail: EmailAddressType }>
  | Readonly<{ _tag: "Invalid"; candidateEmail: EmailAddressType }>
  | Readonly<{ _tag: "FreshPairingRequired" }>
  | Readonly<{ _tag: "Replaced" }>;

type StateCommand = Readonly<{
  onStateChange: (state: EmailReplacementViewState) => void;
}>;
type RequestCommand = StateCommand & Readonly<{ candidateEmail: string }>;
type CompleteCommand = StateCommand &
  Readonly<{ candidateEmail: EmailAddressType; combinedCode: string }>;

const makeRequest = (apiClient: FidyClient): Atom.AtomResultFn<RequestCommand, void, never> =>
  apiClient.runtime.fn<RequestCommand>()(
    ({ candidateEmail, onStateChange }) =>
      Effect.gen(function* () {
        const decoded = Schema.decodeUnknownOption(EmailAddress)(candidateEmail);
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
              : { _tag: "FreshPairingRequired" }
          )
        );
      }),
    { concurrent: false }
  );

const makeComplete = (
  webAuthClient: WebAuthClient
): Atom.AtomResultFn<CompleteCommand, void, never> =>
  webAuthClient.runtime.fn<CompleteCommand>()(
    ({ candidateEmail, combinedCode, onStateChange }) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => onStateChange({ _tag: "Completing", candidateEmail }));
        const client = yield* webAuthClient;
        const result = yield* Effect.result(
          client.emailReplacement.complete({ payload: { combinedCode } })
        );
        yield* Effect.sync(() => {
          if (Result.isSuccess(result)) onStateChange({ _tag: "Replaced" });
          else if (Schema.is(EmailReplacementFreshPairingRequiredApi)(result.failure)) {
            onStateChange({ _tag: "FreshPairingRequired" });
          } else onStateChange({ _tag: "Invalid", candidateEmail });
        });
      }),
    { concurrent: false }
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
  const [completeAtom] = useState(() => makeComplete(router.options.context.webAuthClient));
  const request = useAtomSet(requestAtom);
  const complete = useAtomSet(completeAtom);
  return {
    state,
    request: (candidateEmail: string): void => request({ candidateEmail, onStateChange: setState }),
    complete: (candidateEmail: EmailAddressType, combinedCode: string): void =>
      complete({ candidateEmail, combinedCode, onStateChange: setState }),
    restart: (): void => setState({ _tag: "Editing" }),
  } as const;
};
