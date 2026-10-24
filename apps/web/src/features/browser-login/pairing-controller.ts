import { destinationAfterLogin } from "@/session/login-destination";
import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Clock, type Context, DateTime, Effect, Option, Redacted, Schema } from "effect";
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

export type BrowserLoginPairingViewState =
  | Readonly<{ _tag: "Idle" }>
  | Readonly<{ _tag: "Starting" }>
  | Readonly<{
      _tag: "AwaitingApproval";
      publicCode: string;
      expiresAt: number;
      emailRetryAt: number;
      emailStep: "ready" | "sending" | "code" | "submitting" | "rejected";
    }>
  | Readonly<{ _tag: "Authenticated" }>
  | Readonly<{ _tag: "Invalid" }>
  | Readonly<{ _tag: "Expired"; publicCode: string }>;

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

type PollFailure =
  | Readonly<{ _tag: "Invalid" }>
  | Readonly<{ _tag: "SlowDown"; retryAfterSeconds: number }>
  | Readonly<{ _tag: "Transport" }>;

const classifyPollFailure = (error: unknown): PollFailure => {
  if (Option.isSome(Schema.decodeUnknownOption(BrowserLoginPairingInvalidApi)(error))) {
    return { _tag: "Invalid" };
  }
  return Option.match(Schema.decodeUnknownOption(BrowserLoginPollingRateLimitedApi)(error), {
    onNone: () => ({ _tag: "Transport" }),
    onSome: ({ error: detail }) => ({
      _tag: "SlowDown",
      retryAfterSeconds: detail.retryAfterSeconds,
    }),
  });
};

const millisecondsPerSecond = 1_000;
const pollTimeoutMilliseconds = 15_000;
const invalidState = { _tag: "Invalid" } as const satisfies BrowserLoginPairingViewState;

type DirectWebAuthClient = Context.Service.Shape<WebAuthClient>;
type StartedPairing = WebAuthSuccess<"browserLogin", "startPairing">;
type RedeemResult = WebAuthSuccess<"browserLogin", "redeemPairing">;
type PollAttempt = PollFailure | Readonly<{ _tag: "Success"; value: RedeemResult }>;

const requestPairingPoll = (
  client: DirectWebAuthClient,
  pairing: StartedPairing,
  remainingMilliseconds: number
): Effect.Effect<Option.Option<PollAttempt>> =>
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
        onSuccess: (value): PollAttempt => ({ _tag: "Success", value }),
      }),
      Effect.timeoutOption(Math.max(1, Math.min(remainingMilliseconds, pollTimeoutMilliseconds)))
    );

type PollLoopInput = Readonly<{
  client: DirectWebAuthClient;
  pairing: StartedPairing;
  expiresAtEpochMillis: number;
  onAuthenticated: () => void;
  onStateChange: (state: BrowserLoginPairingViewState) => void;
}>;

type TerminalPollFailure = Extract<PollFailure, { _tag: "Invalid" | "Transport" }>;
const isTerminalPollFailure = (result: PollAttempt): result is TerminalPollFailure =>
  result._tag === "Invalid" || result._tag === "Transport";

const pollBrowserLoginPairing = Effect.fn("BrowserLoginPairing.poll")(function* (
  input: PollLoopInput
): Effect.fn.Return<void> {
  const { client, expiresAtEpochMillis, onAuthenticated, onStateChange, pairing } = input;
  let intervalSeconds: number = pairing.pollingIntervalSeconds;
  for (;;) {
    const remainingBeforeWait = expiresAtEpochMillis - DateTime.toEpochMillis(yield* DateTime.now);
    if (remainingBeforeWait <= 0) {
      yield* Effect.sync(() => onStateChange({ _tag: "Expired", publicCode: pairing.publicCode }));
      return;
    }
    yield* Effect.sleep(Math.min(remainingBeforeWait, intervalSeconds * millisecondsPerSecond));
    const remainingBeforePoll = expiresAtEpochMillis - DateTime.toEpochMillis(yield* DateTime.now);
    if (remainingBeforePoll <= 0) {
      yield* Effect.sync(() => onStateChange({ _tag: "Expired", publicCode: pairing.publicCode }));
      return;
    }
    const polled = yield* requestPairingPoll(client, pairing, remainingBeforePoll);
    if (Option.isNone(polled)) {
      intervalSeconds *= 2;
      continue;
    }
    const result = polled.value;
    if (isTerminalPollFailure(result)) {
      yield* Effect.sync(() => onStateChange(invalidState));
      return;
    }
    if (result._tag === "SlowDown") {
      intervalSeconds = Math.max(intervalSeconds, result.retryAfterSeconds);
      continue;
    }
    if (result.value.status === "pending_approval") {
      intervalSeconds = Math.max(intervalSeconds, result.value.pollingIntervalSeconds);
      continue;
    }
    yield* Effect.sync(onAuthenticated);
    return;
  }
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
        input.onStateChange({ _tag: "Starting" });
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
        onCurrentStateChange({
          _tag: "AwaitingApproval",
          publicCode: pairing.publicCode,
          expiresAt: DateTime.toEpochMillis(pairing.expiresAt),
          emailRetryAt: secrets.emailRetryAt(),
          emailStep: "ready",
        });
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
        command.onStateChange({
          _tag: "AwaitingApproval",
          publicCode: pairing.value.publicCode,
          expiresAt: DateTime.toEpochMillis(pairing.value.expiresAt),
          emailRetryAt: secrets.emailRetryAt(),
          emailStep: "sending",
        });
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
          command.onStateChange({
            _tag: "AwaitingApproval",
            publicCode: pairing.value.publicCode,
            expiresAt: DateTime.toEpochMillis(pairing.value.expiresAt),
            emailStep: "code",
            emailRetryAt: secrets.emailRetryAt(),
          });
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
        command.onStateChange({
          _tag: "AwaitingApproval",
          publicCode: pairing.value.publicCode,
          expiresAt: DateTime.toEpochMillis(pairing.value.expiresAt),
          emailRetryAt: secrets.emailRetryAt(),
          emailStep: "submitting",
        });
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
        command.onStateChange({
          _tag: "AwaitingApproval",
          publicCode: pairing.value.publicCode,
          expiresAt: DateTime.toEpochMillis(pairing.value.expiresAt),
          emailRetryAt: secrets.emailRetryAt(),
          emailStep: "rejected",
        });
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

/** Creates authentication-lifetime commands while keeping all proofs in one private closure. */
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
      emailBusy.current = true;
      controller.stageEmail(email);
      runRequestEmail({ onStateChange: changeState });
    };
    if (latestState.current._tag === "Idle") begin(send);
    else if (latestState.current._tag === "AwaitingApproval") send();
  };
  const resendEmail = (): void => {
    if (
      emailBusy.current ||
      latestState.current._tag !== "AwaitingApproval" ||
      latestState.current.emailRetryAt > Effect.runSync(Clock.currentTimeMillis)
    ) {
      return;
    }
    if (controller.stageResend()) {
      emailBusy.current = true;
      runRequestEmail({ onStateChange: changeState });
    }
  };
  const completeEmail = (combinedCode: VerifiedEmailCombinedCode): void => {
    if (emailBusy.current || latestState.current._tag !== "AwaitingApproval") return;
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
const usePairingPresentation = (): PairingPresentation => {
  const latestState = useRef<BrowserLoginPairingViewState>({ _tag: "Idle" });
  const startBusy = useRef(false);
  const emailBusy = useRef(false);
  const [pairingState, setPairingState] = useState<BrowserLoginPairingViewState>({ _tag: "Idle" });
  const changeState = (next: BrowserLoginPairingViewState): void => {
    if (next._tag !== "Starting") startBusy.current = false;
    if (
      next._tag !== "AwaitingApproval" ||
      (next.emailStep !== "sending" && next.emailStep !== "submitting")
    ) {
      emailBusy.current = false;
    }
    latestState.current = next;
    setPairingState(next);
  };
  const admitStart = (): boolean => {
    if (startBusy.current || latestState.current._tag !== "Idle") return false;
    startBusy.current = true;
    return true;
  };
  return { latestState, admitStart, emailBusy, pairingState, changeState };
};

/**
 * Owns browser-pairing presentation, command execution, and authentication-lifetime transitions.
 * Its small interface never exposes the pairing id, verifier, callbacks, or Atom commands.
 */
export const useBrowserLoginPairing = (): BrowserLoginPairing => {
  const router = useRouter();
  const { authentication, completeLogin, completeLogout, replaceAuthenticationLifetime } =
    useSession();
  const [controller] = useState(() =>
    makeBrowserLoginPairingController(router.options.context.webAuthClient)
  );
  const { latestState, admitStart, emailBusy, pairingState, changeState } =
    usePairingPresentation();
  const { startPairing, runRequestEmail, runCompleteEmail, runLogout, clear, mounted } =
    usePairingExecution(controller);
  const state: BrowserLoginPairingViewState =
    authentication === "signed-in" ? { _tag: "Authenticated" } : pairingState;

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
    controller.clear();
    changeState({ _tag: "Idle" });
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
      changeState({ _tag: "Idle" });
    },
    ...emailActions,
    logout,
  };
};
