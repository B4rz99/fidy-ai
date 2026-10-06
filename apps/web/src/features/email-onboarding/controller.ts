import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Effect, Option, Redacted, Result, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { EmailVerificationInvalidApi, type WebAuthClient } from "@/transport/client";

export type EmailOnboardingViewState =
  | Readonly<{ _tag: "Editing" }>
  | Readonly<{ _tag: "Submitting" }>
  | Readonly<{ _tag: "Invalid" }>
  | Readonly<{ _tag: "Unavailable" }>
  | Readonly<{ _tag: "Recovery"; backupRecoveryCode: string }>
  | Readonly<{ _tag: "Acknowledged" }>;

export const emailVerificationResultState = <Code extends string>(
  backupRecoveryCode: Option.Option<Redacted.Redacted<Code>>
): EmailOnboardingViewState =>
  Option.isNone(backupRecoveryCode)
    ? { _tag: "Invalid" }
    : {
        _tag: "Recovery",
        backupRecoveryCode: Redacted.value(backupRecoveryCode.value),
      };

const verificationFailureState = (failure: unknown): EmailOnboardingViewState =>
  Schema.is(EmailVerificationInvalidApi)(failure) ? { _tag: "Invalid" } : { _tag: "Unavailable" };

type VerificationOwner = Readonly<{
  atom: Atom.AtomResultFn<void, void>;
  stage: (code: string) => void;
  clear: () => void;
}>;

const verifyEmail = (
  webAuthClient: WebAuthClient,
  combinedCode: string,
  onStateChange: (state: EmailOnboardingViewState) => void
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.sync(() => onStateChange({ _tag: "Submitting" }));
    const client = yield* webAuthClient;
    const result = yield* Effect.result(
      client.emailOnboarding.verifyEmail({ payload: { combinedCode } })
    );
    yield* Effect.sync(() =>
      onStateChange(
        Result.isSuccess(result)
          ? emailVerificationResultState(Option.some(result.success.backupRecoveryCode))
          : verificationFailureState(result.failure)
      )
    );
  });

const makeController = (
  webAuthClient: WebAuthClient,
  onStateChange: (state: EmailOnboardingViewState) => void
): VerificationOwner => {
  let pending = Option.none<string>();
  const atom = webAuthClient.runtime.fn<void>()(
    () =>
      Effect.suspend(() => {
        const submitted = pending;
        pending = Option.none();
        if (Option.isNone(submitted)) return Effect.interrupt;
        return verifyEmail(webAuthClient, submitted.value, onStateChange);
      }),
    { concurrent: false }
  );
  return {
    atom,
    stage: (code: string): void => {
      pending = Option.some(code);
    },
    clear: (): void => {
      pending = Option.none();
    },
  };
};

type EmailOnboardingController = Readonly<{
  state: EmailOnboardingViewState;
  verify: (combinedCode: string) => void;
  restart: () => void;
  acknowledge: () => void;
}>;

export const useEmailOnboarding = (): EmailOnboardingController => {
  const router = useRouter();
  const [state, setState] = useState<EmailOnboardingViewState>({ _tag: "Editing" });
  const [controller] = useState(() =>
    makeController(router.options.context.webAuthClient, setState)
  );
  const verify = useAtomSet(controller.atom);
  return {
    state,
    verify: (combinedCode: string): void => {
      controller.stage(combinedCode);
      verify(undefined);
    },
    restart: (): void => {
      controller.clear();
      verify(Atom.Interrupt);
      setState({ _tag: "Editing" });
    },
    acknowledge: (): void => setState({ _tag: "Acknowledged" }),
  } as const;
};
