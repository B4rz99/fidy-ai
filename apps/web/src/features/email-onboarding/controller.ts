import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Effect, Option, Redacted } from "effect";
import type { Atom } from "effect/unstable/reactivity";
import { useState } from "react";
import type { WebAuthClient } from "@/transport/client";

export type EmailOnboardingViewState =
  | Readonly<{ _tag: "Editing" }>
  | Readonly<{ _tag: "Submitting" }>
  | Readonly<{ _tag: "Invalid" }>
  | Readonly<{ _tag: "Recovery"; backupRecoveryCode: string }>
  | Readonly<{ _tag: "Acknowledged" }>;

type VerifyCommand = Readonly<{
  combinedCode: string;
  onStateChange: (state: EmailOnboardingViewState) => void;
}>;

export const emailVerificationResultState = <Code extends string>(
  backupRecoveryCode: Option.Option<Redacted.Redacted<Code>>
): EmailOnboardingViewState =>
  Option.isNone(backupRecoveryCode)
    ? { _tag: "Invalid" }
    : {
        _tag: "Recovery",
        backupRecoveryCode: Redacted.value(backupRecoveryCode.value),
      };

const recoveryCodeOption = <Code extends string>(
  result: Option.Option<Readonly<{ backupRecoveryCode: Redacted.Redacted<Code> }>>
): Option.Option<Redacted.Redacted<Code>> =>
  result.pipe(Option.map(({ backupRecoveryCode }) => backupRecoveryCode));

const makeController = (
  webAuthClient: WebAuthClient
): Atom.AtomResultFn<VerifyCommand, void, never> =>
  webAuthClient.runtime.fn<VerifyCommand>()(
    ({ combinedCode, onStateChange }) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => onStateChange({ _tag: "Submitting" }));
        const client = yield* webAuthClient;
        const result = yield* Effect.option(
          client.emailOnboarding.verifyEmail({ payload: { combinedCode } })
        );
        yield* Effect.sync(() =>
          onStateChange(result.pipe(recoveryCodeOption, emailVerificationResultState))
        );
      }),
    { concurrent: false }
  );

type EmailOnboardingController = Readonly<{
  state: EmailOnboardingViewState;
  verify: (combinedCode: string) => void;
  restart: () => void;
  acknowledge: () => void;
}>;

export const useEmailOnboarding = (): EmailOnboardingController => {
  const router = useRouter();
  const [state, setState] = useState<EmailOnboardingViewState>({ _tag: "Editing" });
  const [controller] = useState(() => makeController(router.options.context.webAuthClient));
  const verify = useAtomSet(controller);
  return {
    state,
    verify: (combinedCode: string): void => verify({ combinedCode, onStateChange: setState }),
    restart: (): void => setState({ _tag: "Editing" }),
    acknowledge: (): void => setState({ _tag: "Acknowledged" }),
  } as const;
};
