import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { type Context, DateTime, Effect, Option, Redacted, Schema } from "effect";
import type { Atom } from "effect/unstable/reactivity";
import { useState } from "react";
import { useSession } from "@/session/session-context";
import {
  BrowserLoginPairingInvalidApi,
  BrowserLoginPollingRateLimitedApi,
  type EmailAddress,
  type EmailVerificationCode,
  type WebAuthClient,
} from "@/transport/client";

/** Generic browser copy for every terminal pairing refusal. */
export const invalidPairingMessage = "Esta vinculación ya no es válida. Inicia de nuevo." as const;

/** Irreducible interaction states rendered by the browser-pairing surface. */
export type BrowserLoginPairingViewState =
  | Readonly<{ _tag: "Idle" }>
  | Readonly<{ _tag: "Starting" }>
  | Readonly<{
      _tag: "AwaitingApproval";
      publicCode: string;
      emailStep: "ready" | "sending" | "code" | "submitting" | "rejected";
    }>
  | Readonly<{ _tag: "Authenticated" }>
  | Readonly<{ _tag: "Invalid" }>;

type StartPairingCommand = Readonly<{
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
type StartedPairing = Effect.Success<
  ReturnType<DirectWebAuthClient["browserLogin"]["startPairing"]>
>;
type RedeemResult = Effect.Success<
  ReturnType<DirectWebAuthClient["browserLogin"]["redeemPairing"]>
>;
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
      yield* Effect.sync(() => onStateChange(invalidState));
      return;
    }
    yield* Effect.sleep(Math.min(remainingBeforeWait, intervalSeconds * millisecondsPerSecond));
    const remainingBeforePoll = expiresAtEpochMillis - DateTime.toEpochMillis(yield* DateTime.now);
    if (remainingBeforePoll <= 0) {
      yield* Effect.sync(() => onStateChange(invalidState));
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
}>;

const makePairingSecretClosure = (): PairingSecretClosure => {
  let activePairing = Option.none<StartedPairing>();
  let requestedEmail = Option.none<VerifiedEmailAddress>();
  let rememberedEmail = Option.none<VerifiedEmailAddress>();
  let submittedCombinedCode = Option.none<VerifiedEmailCombinedCode>();
  let generation = 0;
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
      generation += 1;
    },
    generation: () => generation,
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
        const pairing = started.value;
        secrets.setActive(pairing);
        const onCurrentStateChange = (state: BrowserLoginPairingViewState): void => {
          if (secrets.generation() === generation) input.onStateChange(state);
        };
        onCurrentStateChange({
          _tag: "AwaitingApproval",
          publicCode: pairing.publicCode,
          emailStep: "ready",
        });
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
          emailStep: "sending",
        });
        const client = yield* webAuthClient;
        yield* client.browserPairingEmailAuthentication
          .start({
            payload: {
              pairingId: pairing.value.pairingId,
              privateVerifier: Redacted.value(pairing.value.privateVerifier),
              email: email.value,
            },
          })
          .pipe(Effect.ignore);
        if (secrets.generation() === generation) {
          command.onStateChange({
            _tag: "AwaitingApproval",
            publicCode: pairing.value.publicCode,
            emailStep: "code",
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

/** The complete browser-pairing interface consumed by its rendering surface. */
export type BrowserLoginPairing = Readonly<{
  state: BrowserLoginPairingViewState;
  start: () => void;
  restart: () => void;
  requestEmail: (email: VerifiedEmailAddress) => void;
  resendEmail: () => void;
  completeEmail: (combinedCode: VerifiedEmailCombinedCode) => void;
  logout: () => void;
}>;

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
  const [pairingState, setPairingState] = useState<BrowserLoginPairingViewState>({ _tag: "Idle" });
  const startPairing = useAtomSet(controller.startPairing);
  const runRequestEmail = useAtomSet(controller.requestEmail);
  const runCompleteEmail = useAtomSet(controller.completeEmail);
  const runLogout = useAtomSet(controller.logout);
  const state: BrowserLoginPairingViewState =
    authentication === "signed-in" ? { _tag: "Authenticated" } : pairingState;

  const start = (): void => {
    startPairing({
      onAuthenticated: () => {
        completeLogin();
        router.navigate({ to: "/app/transactions" }).catch(() => undefined);
      },
      onStateChange: setPairingState,
    });
  };
  const logout = (): void => {
    runLogout({ onLoggedOut: completeLogout });
  };
  const restart = (): void => {
    controller.clear();
    setPairingState({ _tag: "Idle" });
    replaceAuthenticationLifetime();
  };

  const requestEmail = (email: VerifiedEmailAddress): void => {
    controller.stageEmail(email);
    runRequestEmail({ onStateChange: setPairingState });
  };
  const resendEmail = (): void => {
    if (controller.stageResend()) runRequestEmail({ onStateChange: setPairingState });
  };
  const completeEmail = (combinedCode: VerifiedEmailCombinedCode): void => {
    controller.stageCombinedCode(combinedCode);
    runCompleteEmail({ onStateChange: setPairingState });
  };

  return { state, start, restart, requestEmail, resendEmail, completeEmail, logout };
};
