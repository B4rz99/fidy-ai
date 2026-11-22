import { destinationAfterLogin } from "@/session/login-destination";
import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Data, DateTime, Effect, Option, Redacted, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { type RefCallback, type RefObject, useCallback, useRef, useState } from "react";
import { useSession } from "@/session/session-context";
import {
  BrowserLoginPairingInvalidApi,
  BrowserLoginPollingRateLimitedApi,
  type EmailAddress,
  type EmailVerificationCode,
  type WebAuthClient,
  type WebAuthSuccess,
} from "@/transport/client";

export const invalidPairingMessage = "Esta vinculación ya no es válida. Inicia de nuevo." as const;

export type BrowserLoginPairingViewState = Data.TaggedEnum<{
  Idle: {};
  Starting: {};
  AwaitingApproval: Readonly<{
    publicCode: string;
    expiresAt: number;
    emailRetryAt: number;
    emailStep: "ready" | "sending" | "code" | "submitting" | "rejected";
  }>;
  Authenticated: {};
  Invalid: {};
  Uncertain: {};
  Expired: Readonly<{ publicCode: string }>;
}>;

export const BrowserLoginPairingViewState = Data.taggedEnum<BrowserLoginPairingViewState>();

type StartPairingCommand = Readonly<{
  onReady: () => void;
  onAuthenticated: () => void;
  onStateChange: (state: BrowserLoginPairingViewState) => void;
}>;

type LogoutCommand = Readonly<{
  onLoggedOut: () => void;
}>;

type EmailCommand = Readonly<{
  onStateChange: (state: BrowserLoginPairingViewState) => void;
}>;

type StartedPairing = WebAuthSuccess<"browserLogin", "startPairing">;

type RedeemResult = WebAuthSuccess<"browserLogin", "redeemPairing">;

type PollAttempt = Data.TaggedEnum<{
  Invalid: {};
  SlowDown: Readonly<{ retryAfterSeconds: number }>;
  Transport: {};
  Success: Readonly<{ value: RedeemResult }>;
}>;

const PollAttempt = Data.taggedEnum<PollAttempt>();

const classifyPollFailure = (error: unknown): PollAttempt => {
  if (Option.isSome(Schema.decodeUnknownOption(BrowserLoginPairingInvalidApi)(error))) {
    return PollAttempt.Invalid();
  }

  return Option.match(Schema.decodeUnknownOption(BrowserLoginPollingRateLimitedApi)(error), {
    onNone: () => PollAttempt.Transport(),
    onSome: ({ error: detail }) =>
      PollAttempt.SlowDown({ retryAfterSeconds: detail.retryAfterSeconds }),
  });
};

const millisecondsPerSecond = 1_000;

const pollTimeoutMilliseconds = 15_000;

const invalidState = BrowserLoginPairingViewState.Invalid();

type DirectWebAuthClient = WebAuthClient["Service"];

const requestPairingPoll = (
  client: DirectWebAuthClient,
  pairing: StartedPairing,
  remainingMilliseconds: number
): Effect.Effect<PollAttempt> =>
  client.browserLogin
    .redeemPairing({
      payload: {
        pairingId: pairing.pairingId,
        privateVerifier: Redacted.value(pairing.privateVerifier),
      },
    })
    .pipe(
      Effect.match({
        onFailure: classifyPollFailure,
        onSuccess: (value) => PollAttempt.Success({ value }),
      }),
      Effect.catchDefect(() => Effect.succeed(PollAttempt.Transport())),
      Effect.timeoutOption(Math.max(1, Math.min(remainingMilliseconds, pollTimeoutMilliseconds))),
      Effect.map(Option.getOrElse((): PollAttempt => PollAttempt.Transport()))
    );

type PollLoopInput = Readonly<{
  client: DirectWebAuthClient;
  pairing: StartedPairing;
  expiresAtEpochMillis: number;
  onAuthenticated: () => void;
  onStateChange: (state: BrowserLoginPairingViewState) => void;
}>;

const pollUntilSettled = Effect.fnUntraced(function* (
  input: PollLoopInput,
  intervalSeconds: number
): Effect.fn.Return<void> {
  const { client, expiresAtEpochMillis, onAuthenticated, onStateChange, pairing } = input;

  const expire = Effect.sync(() =>
    onStateChange(BrowserLoginPairingViewState.Expired({ publicCode: pairing.publicCode }))
  );

  const remainingBeforeWait = expiresAtEpochMillis - DateTime.toEpochMillis(yield* DateTime.now);

  if (remainingBeforeWait <= 0) return yield* expire;

  yield* Effect.sleep(Math.min(remainingBeforeWait, intervalSeconds * millisecondsPerSecond));
  const remainingBeforePoll = expiresAtEpochMillis - DateTime.toEpochMillis(yield* DateTime.now);

  if (remainingBeforePoll <= 0) return yield* expire;

  const result = yield* requestPairingPoll(client, pairing, remainingBeforePoll);
  const remainingAfterPoll = expiresAtEpochMillis - DateTime.toEpochMillis(yield* DateTime.now);

  if (remainingAfterPoll <= 0) return yield* expire;

  return yield* PollAttempt.$match(result, {
    Invalid: () => Effect.sync(() => onStateChange(invalidState)),
    Transport: () => Effect.sync(() => onStateChange(BrowserLoginPairingViewState.Uncertain())),
    SlowDown: ({ retryAfterSeconds }) =>
      pollUntilSettled(input, Math.max(intervalSeconds, retryAfterSeconds)),
    Success: ({ value }) =>
      value.status === "pending_approval"
        ? pollUntilSettled(input, Math.max(intervalSeconds, value.pollingIntervalSeconds))
        : Effect.sync(onAuthenticated),
  });
});

const pollBrowserLoginPairing = Effect.fn("BrowserLoginPairing.poll")(function* (
  input: PollLoopInput
): Effect.fn.Return<void> {
  yield* pollUntilSettled(input, input.pairing.pollingIntervalSeconds);
});

type VerifiedEmailAddress = EmailAddress;

type VerifiedEmailCombinedCode = EmailVerificationCode;

type PairingSecretClosure = Readonly<{
  active: () => Option.Option<StartedPairing>;
  setActive: (pairing: StartedPairing) => void;
  stageEmail: (email: VerifiedEmailAddress) => void;
  stageCombinedCode: (combinedCode: VerifiedEmailCombinedCode) => void;
  takeEmail: () => Option.Option<VerifiedEmailAddress>;
  stageResend: () => boolean;
  takeCombinedCode: () => Option.Option<VerifiedEmailCombinedCode>;
  clear: () => void;
  generation: () => number;
  emailRetryAt: () => number;
  setEmailRetryAt: (deadline: number) => void;
}>;

const makePairingSecretClosure = (): PairingSecretClosure => {
  let activePairing = Option.none<StartedPairing>();
  let requestedEmail = Option.none<VerifiedEmailAddress>();
  let rememberedEmail = Option.none<VerifiedEmailAddress>();
  let submittedCombinedCode = Option.none<VerifiedEmailCombinedCode>();
  let generation = 0;
  let emailRetryAt = 0;

  return {
    active: () => activePairing,
    setActive: (pairing) => {
      activePairing = Option.some(pairing);
    },
    stageEmail: (email) => {
      requestedEmail = Option.some(email);
      rememberedEmail = Option.some(email);
    },
    stageCombinedCode: (combinedCode) => {
      submittedCombinedCode = Option.some(combinedCode);
    },
    takeEmail: () => {
      const value = requestedEmail;
      requestedEmail = Option.none();

      return value;
    },
    stageResend: () => {
      if (Option.isNone(rememberedEmail)) return false;
      requestedEmail = rememberedEmail;

      return true;
    },
    takeCombinedCode: () => {
      const value = submittedCombinedCode;
      submittedCombinedCode = Option.none();

      return value;
    },
    clear: () => {
      activePairing = Option.none();
      requestedEmail = Option.none();
      rememberedEmail = Option.none();
      submittedCombinedCode = Option.none();
      emailRetryAt = 0;
      generation += 1;
    },
    generation: () => generation,
    emailRetryAt: () => emailRetryAt,
    setEmailRetryAt: (deadline) => {
      emailRetryAt = deadline;
    },
  };
};

const makeStartPairingCommand = (
  webAuthClient: WebAuthClient,
  secrets: PairingSecretClosure
): Atom.AtomResultFn<StartPairingCommand, void, never> =>
  webAuthClient.runtime.fn<StartPairingCommand>()(
    (input) =>
      Effect.gen(function* () {
        secrets.clear();
        const generation = secrets.generation();
        input.onStateChange(BrowserLoginPairingViewState.Starting());
        const client = yield* webAuthClient;
        const started = yield* client.browserLogin.startPairing().pipe(Effect.option);

        if (Option.isNone(started)) {
          if (secrets.generation() === generation) input.onStateChange(invalidState);

          return;
        }

        if (secrets.generation() !== generation) return;
        const pairing = started.value;
        secrets.setActive(pairing);

        const onCurrentStateChange = (state: BrowserLoginPairingViewState): void => {
          if (secrets.generation() === generation) input.onStateChange(state);
        };

        onCurrentStateChange(
          BrowserLoginPairingViewState.AwaitingApproval({
            publicCode: pairing.publicCode,
            expiresAt: DateTime.toEpochMillis(pairing.expiresAt),
            emailRetryAt: secrets.emailRetryAt(),
            emailStep: "ready",
          })
        );
        input.onReady();
        yield* pollBrowserLoginPairing({
          client,
          pairing,
          expiresAtEpochMillis: DateTime.toEpochMillis(pairing.expiresAt),
          onAuthenticated: () => {
            if (secrets.generation() === generation) input.onAuthenticated();
          },
          onStateChange: onCurrentStateChange,
        });

        if (secrets.generation() === generation) secrets.clear();
      }),
    { concurrent: false }
  );

const makeRequestEmailCommand = (
  webAuthClient: WebAuthClient,
  secrets: PairingSecretClosure
): Atom.AtomResultFn<EmailCommand, void, never> =>
  webAuthClient.runtime.fn<EmailCommand>()(
    (command) =>
      Effect.gen(function* () {
        const pairing = secrets.active();
        const email = secrets.takeEmail();
        const generation = secrets.generation();

        if (Option.isNone(pairing) || Option.isNone(email)) return;
        command.onStateChange(
          BrowserLoginPairingViewState.AwaitingApproval({
            publicCode: pairing.value.publicCode,
            expiresAt: DateTime.toEpochMillis(pairing.value.expiresAt),
            emailRetryAt: secrets.emailRetryAt(),
            emailStep: "sending",
          })
        );
        const client = yield* webAuthClient;

        const requested = yield* client.browserPairingEmailAuthentication
          .start({
            payload: {
              pairingId: pairing.value.pairingId,
              privateVerifier: Redacted.value(pairing.value.privateVerifier),
              email: email.value,
            },
          })
          .pipe(Effect.option);

        if (secrets.generation() === generation) {
          if (Option.isSome(requested)) {
            secrets.setEmailRetryAt(
              DateTime.toEpochMillis(yield* DateTime.now) +
                requested.value.retryAfterSeconds * millisecondsPerSecond
            );
          }

          command.onStateChange(
            BrowserLoginPairingViewState.AwaitingApproval({
              publicCode: pairing.value.publicCode,
              expiresAt: DateTime.toEpochMillis(pairing.value.expiresAt),
              emailStep: "code",
              emailRetryAt: secrets.emailRetryAt(),
            })
          );
        }
      }),
    { concurrent: false }
  );

const makeCompleteEmailCommand = (
  webAuthClient: WebAuthClient,
  secrets: PairingSecretClosure
): Atom.AtomResultFn<EmailCommand, void, never> =>
  webAuthClient.runtime.fn<EmailCommand>()(
    (command) =>
      Effect.gen(function* () {
        const pairing = secrets.active();
        const combinedCode = secrets.takeCombinedCode();
        const generation = secrets.generation();

        if (Option.isNone(pairing) || Option.isNone(combinedCode)) return;
        command.onStateChange(
          BrowserLoginPairingViewState.AwaitingApproval({
            publicCode: pairing.value.publicCode,
            expiresAt: DateTime.toEpochMillis(pairing.value.expiresAt),
            emailRetryAt: secrets.emailRetryAt(),
            emailStep: "submitting",
          })
        );
        const client = yield* webAuthClient;

        const approved = yield* client.browserPairingEmailAuthentication
          .complete({
            payload: {
              pairingId: pairing.value.pairingId,
              privateVerifier: Redacted.value(pairing.value.privateVerifier),
              combinedCode: combinedCode.value,
            },
          })
          .pipe(Effect.option);

        if (Option.isSome(approved) || secrets.generation() !== generation) return;
        command.onStateChange(
          BrowserLoginPairingViewState.AwaitingApproval({
            publicCode: pairing.value.publicCode,
            expiresAt: DateTime.toEpochMillis(pairing.value.expiresAt),
            emailRetryAt: secrets.emailRetryAt(),
            emailStep: "rejected",
          })
        );
      }),
    { concurrent: false }
  );

const makeLogoutCommand = (
  webAuthClient: WebAuthClient,
  secrets: PairingSecretClosure
): Atom.AtomResultFn<LogoutCommand, void, never> =>
  webAuthClient.runtime.fn<LogoutCommand>()(
    ({ onLoggedOut }) =>
      Effect.gen(function* () {
        const client = yield* webAuthClient;
        yield* client.browserLogin.logout();
        secrets.clear();
        yield* Effect.sync(onLoggedOut);
      }).pipe(Effect.orDie),
    { concurrent: false }
  );

type BrowserLoginPairingController = Readonly<{
  startPairing: Atom.AtomResultFn<StartPairingCommand, void, never>;
  requestEmail: Atom.AtomResultFn<EmailCommand, void, never>;
  completeEmail: Atom.AtomResultFn<EmailCommand, void, never>;
  clear: () => void;
  stageEmail: (email: VerifiedEmailAddress) => void;
  stageCombinedCode: (combinedCode: VerifiedEmailCombinedCode) => void;
  stageResend: () => boolean;
  logout: Atom.AtomResultFn<LogoutCommand, void, never>;
}>;

const makeBrowserLoginPairingController = (
  webAuthClient: WebAuthClient
): BrowserLoginPairingController => {
  const secrets = makePairingSecretClosure();

  return {
    startPairing: makeStartPairingCommand(webAuthClient, secrets),
    requestEmail: makeRequestEmailCommand(webAuthClient, secrets),
    completeEmail: makeCompleteEmailCommand(webAuthClient, secrets),
    clear: secrets.clear,
    stageEmail: secrets.stageEmail,
    stageCombinedCode: secrets.stageCombinedCode,
    stageResend: secrets.stageResend,
    logout: makeLogoutCommand(webAuthClient, secrets),
  } as const;
};

export type BrowserLoginPairing = Readonly<{
  mounted: RefCallback<HTMLElement>;
  state: BrowserLoginPairingViewState;
  start: () => void;
  restart: () => void;
  cancel: () => void;
  requestEmail: (email: VerifiedEmailAddress) => void;
  resendEmail: () => void;
  completeEmail: (combinedCode: VerifiedEmailCombinedCode) => void;
  logout: () => void;
}>;

type PairingExecution = Readonly<{
  startPairing: (input: StartPairingCommand) => void;
  runRequestEmail: (input: EmailCommand) => void;
  runCompleteEmail: (input: EmailCommand) => void;
  runLogout: (input: LogoutCommand) => void;
  clear: () => void;
  mounted: RefCallback<HTMLElement>;
}>;

const usePairingExecution = (controller: BrowserLoginPairingController): PairingExecution => {
  const startPairing = useAtomSet(controller.startPairing);
  const runRequestEmail = useAtomSet(controller.requestEmail);
  const runCompleteEmail = useAtomSet(controller.completeEmail);
  const runLogout = useAtomSet(controller.logout);

  const clear = useCallback(() => {
    controller.clear();
    startPairing(Atom.Interrupt);
    runRequestEmail(Atom.Interrupt);
    runCompleteEmail(Atom.Interrupt);
    runLogout(Atom.Interrupt);
  }, [controller, startPairing, runRequestEmail, runCompleteEmail, runLogout]);

  const mounted = useCallback(
    (node: Parameters<RefCallback<HTMLElement>>[0]) => (node !== null ? clear : undefined),
    [clear]
  );

  return { startPairing, runRequestEmail, runCompleteEmail, runLogout, clear, mounted };
};

type PairingEmailActions = Pick<
  BrowserLoginPairing,
  "requestEmail" | "resendEmail" | "completeEmail"
>;

type WaitingPairing = Data.TaggedEnum.Value<BrowserLoginPairingViewState, "AwaitingApproval">;

const canRequestEmail = (state: BrowserLoginPairingViewState): state is WaitingPairing =>
  BrowserLoginPairingViewState.$is("AwaitingApproval")(state) &&
  state.emailStep === "ready" &&
  state.expiresAt > DateTime.toEpochMillis(DateTime.nowUnsafe());

const canSubmitEmailCode = (state: BrowserLoginPairingViewState): state is WaitingPairing =>
  BrowserLoginPairingViewState.$is("AwaitingApproval")(state) &&
  (state.emailStep === "code" || state.emailStep === "rejected") &&
  state.expiresAt > DateTime.toEpochMillis(DateTime.nowUnsafe());

const makePairingEmailActions = ({
  controller,
  latestState,
  emailBusy,
  begin,
  runRequestEmail,
  runCompleteEmail,
  changeState,
}: Readonly<{
  controller: BrowserLoginPairingController;
  latestState: RefObject<BrowserLoginPairingViewState>;
  emailBusy: RefObject<boolean>;
  begin: (onReady: () => void) => void;
  runRequestEmail: PairingExecution["runRequestEmail"];
  runCompleteEmail: PairingExecution["runCompleteEmail"];
  changeState: EmailCommand["onStateChange"];
}>): PairingEmailActions => {
  const requestEmail = (email: VerifiedEmailAddress): void => {
    if (emailBusy.current) return;

    const send = (): void => {
      if (!canRequestEmail(latestState.current)) return;
      emailBusy.current = true;
      controller.stageEmail(email);
      runRequestEmail({ onStateChange: changeState });
    };

    if (BrowserLoginPairingViewState.$is("Idle")(latestState.current)) begin(send);
    else send();
  };

  const resendEmail = (): void => {
    if (
      emailBusy.current ||
      !canSubmitEmailCode(latestState.current) ||
      latestState.current.emailRetryAt > DateTime.toEpochMillis(DateTime.nowUnsafe())
    ) {
      return;
    }

    if (controller.stageResend()) {
      emailBusy.current = true;
      runRequestEmail({ onStateChange: changeState });
    }
  };

  const completeEmail = (combinedCode: VerifiedEmailCombinedCode): void => {
    if (emailBusy.current || !canSubmitEmailCode(latestState.current)) return;
    emailBusy.current = true;
    controller.stageCombinedCode(combinedCode);
    runCompleteEmail({ onStateChange: changeState });
  };

  return { requestEmail, resendEmail, completeEmail };
};

type PairingPresentation = Readonly<{
  latestState: RefObject<BrowserLoginPairingViewState>;
  admitStart: () => boolean;
  emailBusy: RefObject<boolean>;
  pairingState: BrowserLoginPairingViewState;
  changeState: EmailCommand["onStateChange"];
}>;

const isRetiredPairing = (state: BrowserLoginPairingViewState): boolean =>
  BrowserLoginPairingViewState.$is("Invalid")(state) ||
  BrowserLoginPairingViewState.$is("Expired")(state) ||
  BrowserLoginPairingViewState.$is("Uncertain")(state);

const idlePairingState = BrowserLoginPairingViewState.Idle();

const usePairingPresentation = (retire: () => void): PairingPresentation => {
  const latestState = useRef<BrowserLoginPairingViewState>(idlePairingState);
  const startBusy = useRef(false);
  const emailBusy = useRef(false);

  const [pairingState, setPairingState] = useState<BrowserLoginPairingViewState>(idlePairingState);

  const changeState = (next: BrowserLoginPairingViewState): void => {
    if (isRetiredPairing(next)) retire();

    if (!BrowserLoginPairingViewState.$is("Starting")(next)) startBusy.current = false;

    if (
      !BrowserLoginPairingViewState.$is("AwaitingApproval")(next) ||
      (next.emailStep !== "sending" && next.emailStep !== "submitting")
    ) {
      emailBusy.current = false;
    }

    latestState.current = next;
    setPairingState(next);
  };

  const admitStart = (): boolean => {
    if (startBusy.current || !BrowserLoginPairingViewState.$is("Idle")(latestState.current)) {
      return false;
    }

    startBusy.current = true;

    return true;
  };

  return { latestState, admitStart, emailBusy, pairingState, changeState };
};

export const useBrowserLoginPairing = (): BrowserLoginPairing => {
  const router = useRouter();

  const { authentication, completeLogin, completeLogout, replaceAuthenticationLifetime } =
    useSession();

  const [controller] = useState(() =>
    makeBrowserLoginPairingController(router.options.context.webAuthClient)
  );

  const { startPairing, runRequestEmail, runCompleteEmail, runLogout, clear, mounted } =
    usePairingExecution(controller);

  const { latestState, admitStart, emailBusy, pairingState, changeState } =
    usePairingPresentation(clear);

  const state: BrowserLoginPairingViewState =
    authentication === "signed-in" ? BrowserLoginPairingViewState.Authenticated() : pairingState;

  const begin = (onReady: () => void): void => {
    if (!admitStart()) return;
    startPairing({
      onReady,
      onAuthenticated: () => {
        completeLogin();
        window.location.assign(destinationAfterLogin(router.state.location.search));
      },
      onStateChange: changeState,
    });
  };

  const start = (): void => begin(() => undefined);

  const logout = (): void => {
    runLogout({ onLoggedOut: completeLogout });
  };

  const restart = (): void => {
    if (!isRetiredPairing(latestState.current)) return;
    clear();
    changeState(BrowserLoginPairingViewState.Idle());
    replaceAuthenticationLifetime();
  };

  const emailActions = makePairingEmailActions({
    controller,
    latestState,
    emailBusy,
    begin,
    runRequestEmail,
    runCompleteEmail,
    changeState,
  });

  return {
    mounted,
    state,
    start,
    restart,
    cancel: () => {
      clear();
      changeState(BrowserLoginPairingViewState.Idle());
    },
    ...emailActions,
    logout,
  };
};
