import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { type Context, DateTime, Effect, Option, Redacted, Schema } from "effect";
import type { Atom } from "effect/unstable/reactivity";
import { useState } from "react";
import { useSession } from "@/session/session-context";
import {
  BrowserLoginPairingInvalidApi,
  BrowserLoginPollingRateLimitedApi,
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

/**
 * Creates the authentication-lifetime scoped sequential polling command. The pairing id and
 * private verifier remain local variables on the command fiber and never enter React state,
 * routing, storage, or an AsyncResult success value.
 */
const makeBrowserLoginPairingController = (
  webAuthClient: WebAuthClient
): Readonly<{
  startPairing: Atom.AtomResultFn<StartPairingCommand, void, never>;
  logout: Atom.AtomResultFn<LogoutCommand, void, never>;
}> => {
  const startPairing = webAuthClient.runtime.fn<StartPairingCommand>()(
    (input) =>
      Effect.gen(function* () {
        input.onStateChange({ _tag: "Starting" });
        const client = yield* webAuthClient;
        const started = yield* client.browserLogin.startPairing().pipe(Effect.option);
        if (Option.isNone(started)) {
          input.onStateChange(invalidState);
          return;
        }
        const pairing = started.value;
        const expiresAtEpochMillis = DateTime.toEpochMillis(pairing.expiresAt);
        input.onStateChange({
          _tag: "AwaitingApproval",
          publicCode: pairing.publicCode,
        });

        yield* pollBrowserLoginPairing({
          client,
          pairing,
          expiresAtEpochMillis,
          onAuthenticated: input.onAuthenticated,
          onStateChange: input.onStateChange,
        });
      }),
    { concurrent: false }
  );

  const logout = webAuthClient.runtime.fn<LogoutCommand>()(
    ({ onLoggedOut }) =>
      Effect.gen(function* () {
        const client = yield* webAuthClient;
        yield* client.browserLogin.logout();
        yield* Effect.sync(onLoggedOut);
      }).pipe(Effect.orDie),
    { concurrent: false }
  );

  return { startPairing, logout } as const;
};

/** The complete browser-pairing interface consumed by its rendering surface. */
export type BrowserLoginPairing = Readonly<{
  state: BrowserLoginPairingViewState;
  start: () => void;
  restart: () => void;
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
    setPairingState({ _tag: "Idle" });
    replaceAuthenticationLifetime();
  };

  return { state, start, restart, logout };
};
