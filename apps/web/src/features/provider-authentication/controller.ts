import { PATPairingPublicCode } from "@/transport/client";
import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Cause, type Context, Effect, Option, Redacted, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { type RefCallback, useCallback, useState } from "react";
import { useSession } from "@/session/session-context";
import type { AuthenticationProvider, WebAuthClient } from "@/transport/client";

type Client = Context.Service.Shape<WebAuthClient>;
type Pairing = Effect.Success<ReturnType<Client["browserLogin"]["startPairing"]>>;
type CommandError =
  | Effect.Error<ReturnType<Client["browserLogin"]["startPairing"]>>
  | Effect.Error<ReturnType<Client["providerAuthentication"]["start"]>>
  | "rejected"
  | "cancelled";
export type ProviderViewState =
  | Readonly<{ status: "editing" }>
  | Readonly<{ status: "waiting" }>
  | Readonly<{ status: "confirming"; code: string }>
  | Readonly<{ status: "recovery"; code: string }>
  | Readonly<{ status: "uncertain" }>
  | Readonly<{ status: "refused" }>
  | Readonly<{ status: "cancelled" }>;
type Submission = Readonly<{ intent: "signup" | "login"; revision: string; popup: Window }>;
type RetryInput = Pick<Submission, "intent" | "revision">;
const providerClient = (
  client: Client,
  provider: AuthenticationProvider
): Pick<Client["providerAuthentication"], "start" | "status" | "complete"> => {
  const api = client.providerAuthentication;
  return provider === "google"
    ? api
    : { start: api.startMicrosoft, status: api.statusMicrosoft, complete: api.completeMicrosoft };
};
const awaitProviderVerification = (
  client: Client,
  pairing: Pairing,
  input: Pick<ControllerInput, "provider" | "setState"> & Readonly<{ popup: Window }>
): Effect.Effect<void, "rejected" | "cancelled"> =>
  Effect.gen(function* () {
    for (;;) {
      // Read status after observing closure: a response already in flight may predate completion.
      const popupClosed = input.popup.closed;
      const result = yield* providerClient(client, input.provider)
        .status({
          payload: proof(pairing),
        })
        .pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            () => Effect.fail(input.popup.closed ? ("cancelled" as const) : ("rejected" as const))
          )
        );
      if (result.status === "verified") return;
      if (result.status === "awaiting_confirmation") {
        input.setState({ status: "confirming", code: result.associationCode });
      }
      if (result.status === "rejected") return yield* Effect.fail("rejected");
      if (result.status === "pending" && popupClosed) return yield* Effect.fail("cancelled");
      yield* Effect.sleep("1 second");
    }
  }).pipe(
    Effect.timeout("10 minutes"),
    Effect.mapError((error) => (error === "cancelled" ? error : ("rejected" as const)))
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

type ProviderController = Readonly<{
  start: Atom.AtomResultFn<void, void>;
  acknowledge: Atom.AtomResultFn<void, void>;
  clear: () => void;
  cancellation: () => ProviderViewState;
  stage: (submission: Submission) => void;
}>;
type ControllerInput = Readonly<{
  webAuthClient: WebAuthClient;
  setState: (state: ProviderViewState) => void;
  authenticated: () => void;
  provider: AuthenticationProvider;
  handoffReference: Option.Option<string>;
}>;
type ActiveAttempt = {
  submission: Option.Option<Submission>;
  pairing: Option.Option<Pairing>;
  popup: Option.Option<Window>;
  generation: number;
  completionRequested: boolean;
};
const clearAttempt = (active: ActiveAttempt): void => {
  active.generation += 1;
  active.submission = Option.none();
  active.pairing = Option.none();
  Option.map(active.popup, (value) => value.close());
  active.popup = Option.none();
};
const navigateProviderPopup = (
  popup: Window,
  authorizationUrl: string
): Effect.Effect<void, "cancelled"> =>
  popup.closed
    ? Effect.fail("cancelled" as const)
    : Effect.sync(() => popup.location.replace(authorizationUrl));
const failureState = (
  active: ActiveAttempt,
  cause: Cause.Cause<CommandError>
): ProviderViewState => {
  if (active.completionRequested) return { status: "uncertain" };
  const cancelled = Cause.findErrorOption(cause).pipe(
    Option.exists((error) => error === "cancelled")
  );
  return { status: cancelled ? "cancelled" : "refused" };
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
    const authorization = yield* providerClient(client, input.provider).start({
      payload: {
        ...proof(started),
        intent: staged.value.intent,
        consentRevision: staged.value.revision,
        ...Option.match(staged.value.intent === "signup" ? input.handoffReference : Option.none(), {
          onNone: () => ({}),
          onSome: (handoffReference) => ({ handoffReference }),
        }),
      },
    });
    if (active.generation !== current) {
      return;
    }
    yield* navigateProviderPopup(staged.value.popup, authorization.authorizationUrl);
    yield* awaitProviderVerification(client, started, { ...input, popup: staged.value.popup });
    staged.value.popup.close();
    if (active.generation !== current) {
      return;
    }
    active.completionRequested = true;
    const result = yield* providerClient(client, input.provider).complete({
      payload: proof(started),
    });
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
                const state = failureState(active, cause);
                clearAttempt(active);
                input.setState(state);
              })
        )
      );
    },
    { concurrent: false }
  );
const makeProviderController = (input: ControllerInput): ProviderController => {
  const active: ActiveAttempt = {
    submission: Option.none(),
    pairing: Option.none(),
    popup: Option.none(),
    generation: 0,
    completionRequested: false,
  };
  return {
    start: guardedCommand(input, active, () => executeStart(input, active)),
    acknowledge: guardedCommand(input, active, () => executeAcknowledgement(input, active)),
    clear: () => clearAttempt(active),
    cancellation: () => ({ status: active.completionRequested ? "uncertain" : "cancelled" }),
    stage: (value: Submission): void => {
      clearAttempt(active);
      active.completionRequested = false;
      active.submission = Option.some(value);
      active.popup = Option.some(value.popup);
    },
  };
};

/** Owns one mounted Provider attempt; proofs and recovery are discarded on navigation or restart. */
type ProviderAuthentication = Readonly<{
  state: ProviderViewState;
  mounted: RefCallback<HTMLElement>;
  start: (intent: "signup" | "login", revision: string) => void;
  retry: () => void;
  restart: () => void;
  cancel: () => void;
  acknowledge: () => void;
}>;
const startProvider = ({
  controller,
  runStart,
  setState,
  intent,
  revision,
}: Readonly<{
  controller: ProviderController;
  runStart: (value: void) => void;
  setState: ControllerInput["setState"];
}> &
  Pick<Submission, "intent" | "revision">): void => {
  const popup = window.open("about:blank", "_blank", "popup,width=500,height=700");
  if (popup === null) {
    setState({ status: "refused" });
    return;
  }
  popup.opener = null;
  controller.stage({ intent, revision, popup });
  runStart(undefined);
};
export const useProviderAuthentication = ({
  provider,
  handoffReference,
}: Readonly<{
  provider: AuthenticationProvider;
  handoffReference: Option.Option<string>;
}>): ProviderAuthentication => {
  const router = useRouter();
  const session = useSession();
  const [state, setState] = useState<ProviderViewState>({ status: "editing" });
  const [retryInput, setRetryInput] = useState<Option.Option<RetryInput>>(() => Option.none());
  const [controller] = useState(() =>
    makeProviderController({
      webAuthClient: router.options.context.webAuthClient,
      setState,
      provider,
      handoffReference,
      authenticated: () => {
        session.completeLogin();
        window.location.assign(destinationAfterProviderLogin(router.state.location.search.cliCode));
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
  const start = (intent: "signup" | "login", revision: string): void => {
    setRetryInput(Option.some({ intent, revision }));
    startProvider({ controller, runStart, setState, intent, revision });
  };
  return {
    state,
    mounted,
    start,
    retry: (): void => {
      if (state.status !== "refused" && state.status !== "cancelled") return;
      Option.map(retryInput, ({ intent, revision }) => start(intent, revision));
    },
    cancel: (): void => {
      const cancellation = controller.cancellation();
      clear();
      setState(cancellation);
    },
    restart: (): void => {
      clear();
      setRetryInput(Option.none());
      setState({ status: "editing" });
    },
    acknowledge: (): void => runAcknowledgement(undefined),
  };
};

/** Closes the provider popup from the clean first-party return URL. */
export const closeProviderReturn = (node: Parameters<RefCallback<HTMLElement>>[0]): void => {
  if (node === null) return;
  window.close();
};

const destinationAfterProviderLogin = (input: unknown): string =>
  Option.match(Schema.decodeUnknownOption(PATPairingPublicCode)(input), {
    onNone: () => "/app/transactions",
    onSome: (code) => `/connect/cli?cliCode=${encodeURIComponent(code)}`,
  });
