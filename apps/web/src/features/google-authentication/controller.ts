import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Cause, type Context, Effect, Option, Redacted } from "effect";
import { Atom } from "effect/reactivity";
import { type RefCallback, useCallback, useState } from "react";
import { useSession } from "@/session/session-context";
import type { WebAuthClient } from "@/transport/client";

type Client = Context.Service.Shape<WebAuthClient>;
type Pairing = Effect.Success<ReturnType<Client["browserLogin"]["startPairing"]>>;
type CommandError =
  | Effect.Error<ReturnType<Client["browserLogin"]["startPairing"]>>
  | Effect.Error<ReturnType<Client["providerAuthentication"]["start"]>>
  | "rejected";
export type GoogleViewState =
  | Readonly<{ status: "editing" }>
  | Readonly<{ status: "waiting" }>
  | Readonly<{ status: "recovery"; code: string }>
  | Readonly<{ status: "uncertain" }>;
type Submission = Readonly<{ intent: "signup" | "login"; revision: string; popup: Window }>;
const awaitGoogleVerification = (
  client: Client,
  pairing: Pairing
): Effect.Effect<void, "rejected"> =>
  Effect.gen(function* () {
    for (;;) {
      const result = yield* client.providerAuthentication.status({ payload: proof(pairing) });
      if (result.status === "verified") return;
      if (result.status === "rejected") return yield* Effect.fail("rejected");
      yield* Effect.sleep("1 second");
    }
  }).pipe(
    Effect.timeout("10 minutes"),
    Effect.mapError(() => "rejected" as const)
  );

const proof = (
  pairing: Pairing
): Readonly<{
  pairingId: Pairing["pairingId"];
  privateVerifier: Redacted.Redacted.Value<Pairing["privateVerifier"]>;
}> => ({ pairingId: pairing.pairingId, privateVerifier: Redacted.value(pairing.privateVerifier) });
const redeem = (
  input: Readonly<{ client: Client; pairing: Pairing; authenticated: () => void }>
): Effect.Effect<void, "rejected"> =>
  input.client.browserLogin.redeemPairing({ payload: proof(input.pairing) }).pipe(
    Effect.mapError(() => "rejected" as const),
    Effect.flatMap((result) =>
      result.status === "authenticated"
        ? Effect.sync(input.authenticated)
        : Effect.fail("rejected" as const)
    )
  );

type GoogleController = Readonly<{
  start: Atom.AtomResultFn<void, void>;
  acknowledge: Atom.AtomResultFn<void, void>;
  clear: () => void;
  stage: (submission: Submission) => void;
}>;
type ControllerInput = Readonly<{
  webAuthClient: WebAuthClient;
  setState: (state: GoogleViewState) => void;
  authenticated: () => void;
}>;
type ActiveAttempt = {
  submission: Option.Option<Submission>;
  pairing: Option.Option<Pairing>;
  popup: Option.Option<Window>;
  generation: number;
};
const clearAttempt = (active: ActiveAttempt): void => {
  active.generation += 1;
  active.submission = Option.none();
  active.pairing = Option.none();
  Option.map(active.popup, (value) => value.close());
  active.popup = Option.none();
};
const executeStart = (
  input: ControllerInput,
  active: ActiveAttempt
): Effect.Effect<void, CommandError> =>
  Effect.gen(function* () {
    const staged = active.submission;
    active.submission = Option.none();
    if (Option.isNone(staged)) {
      return;
    }
    const current = active.generation;
    input.setState({ status: "waiting" });
    const client = yield* input.webAuthClient;
    const started = yield* client.browserLogin.startPairing();
    if (active.generation !== current) {
      return;
    }
    active.pairing = Option.some(started);
    const authorization = yield* client.providerAuthentication.start({
      payload: {
        ...proof(started),
        intent: staged.value.intent,
        consentRevision: staged.value.revision,
      },
    });
    if (active.generation !== current) {
      return;
    }
    yield* Effect.sync(() => staged.value.popup.location.replace(authorization.authorizationUrl));
    yield* awaitGoogleVerification(client, started);
    staged.value.popup.close();
    if (active.generation !== current) {
      return;
    }
    const result = yield* client.providerAuthentication.complete({ payload: proof(started) });
    if (active.generation !== current) {
      return;
    }
    if (result.status === "created") {
      input.setState({ status: "recovery", code: Redacted.value(result.backupRecoveryCode) });
    } else {
      yield* redeem({ client, pairing: started, authenticated: input.authenticated });
      clearAttempt(active);
    }
  });
const executeAcknowledgement = (
  input: ControllerInput,
  active: ActiveAttempt
): Effect.Effect<void, CommandError> =>
  Effect.gen(function* () {
    const pairing = active.pairing;
    if (Option.isNone(pairing)) {
      return;
    }
    input.setState({ status: "waiting" });
    yield* redeem({
      client: yield* input.webAuthClient,
      pairing: pairing.value,
      authenticated: input.authenticated,
    });
    clearAttempt(active);
  });
const guardedCommand = (
  input: ControllerInput,
  active: ActiveAttempt,
  command: () => Effect.Effect<void, CommandError>
): Atom.AtomResultFn<void, void> =>
  input.webAuthClient.runtime.fn<void>()(
    () => {
      const current = active.generation;
      return command().pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) || active.generation !== current
            ? Effect.void
            : Effect.sync(() => {
                clearAttempt(active);
                input.setState({ status: "uncertain" });
              })
        )
      );
    },
    { concurrent: false }
  );
const makeGoogleController = (input: ControllerInput): GoogleController => {
  const active: ActiveAttempt = {
    submission: Option.none(),
    pairing: Option.none(),
    popup: Option.none(),
    generation: 0,
  };
  return {
    start: guardedCommand(input, active, () => executeStart(input, active)),
    acknowledge: guardedCommand(input, active, () => executeAcknowledgement(input, active)),
    clear: () => clearAttempt(active),
    stage: (value: Submission): void => {
      clearAttempt(active);
      active.submission = Option.some(value);
      active.popup = Option.some(value.popup);
    },
  };
};

/** Owns one mounted Google attempt; proofs and recovery are discarded on navigation or restart. */
type GoogleAuthentication = Readonly<{
  state: GoogleViewState;
  mounted: RefCallback<HTMLElement>;
  start: (intent: "signup" | "login", revision: string) => void;
  restart: () => void;
  cancel: () => void;
  acknowledge: () => void;
}>;
export const useGoogleAuthentication = (): GoogleAuthentication => {
  const router = useRouter();
  const session = useSession();
  const [state, setState] = useState<GoogleViewState>({ status: "editing" });
  const [controller] = useState(() =>
    makeGoogleController({
      webAuthClient: router.options.context.webAuthClient,
      setState,
      authenticated: () => {
        session.completeLogin();
        router.navigate({ to: "/app/transactions" }).catch(() => undefined);
      },
    })
  );
  const runStart = useAtomSet(controller.start);
  const runAcknowledgement = useAtomSet(controller.acknowledge);
  const clear = useCallback(() => {
    controller.clear();
    runStart(Atom.Interrupt);
    runAcknowledgement(Atom.Interrupt);
  }, [controller, runStart, runAcknowledgement]);
  const mounted = useCallback(
    (node: Parameters<RefCallback<HTMLElement>>[0]) => (node !== null ? clear : undefined),
    [clear]
  );
  return {
    state,
    mounted,
    start: (intent: "signup" | "login", revision: string): void => {
      const popup = window.open("about:blank", "_blank", "popup,width=500,height=700");
      if (popup === null) {
        setState({ status: "uncertain" });
        return;
      }
      controller.stage({ intent, revision, popup });
      runStart(undefined);
    },
    cancel: (): void => {
      clear();
      setState({ status: "uncertain" });
    },
    restart: (): void => {
      clear();
      setState({ status: "editing" });
    },
    acknowledge: (): void => runAcknowledgement(undefined),
  };
};

/** Closes the provider popup from the clean first-party return URL. */
export const closeGoogleReturn = (node: Parameters<RefCallback<HTMLElement>>[0]): void => {
  if (node === null) return;
  window.close();
};
