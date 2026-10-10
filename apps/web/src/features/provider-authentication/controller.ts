import { Cause, type Context, Effect, Option, Redacted } from "effect";
import type { AuthenticationProvider, WebAuthClient } from "@/transport/client";
import type { ProviderViewState } from "./model";

type Client = Context.Service.Shape<WebAuthClient>;
type Pairing = Effect.Success<ReturnType<Client["browserLogin"]["startPairing"]>>;
type CommandError =
  | Effect.Error<ReturnType<Client["browserLogin"]["startPairing"]>>
  | Effect.Error<ReturnType<Client["providerAuthentication"]["start"]>>
  | "rejected"
  | "cancelled";
type Submission = Readonly<{ intent: "signup" | "login"; revision: string; popup: Window }>;
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
  recovery: Option.Option<Redacted.Redacted<string>>;
  recoveryElement: Option.Option<Element>;
};
const clearAttempt = (active: ActiveAttempt): void => {
  active.generation += 1;
  eraseRecovery(active);
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
      active.recovery = Option.some(result.backupRecoveryCode);
      input.setState({ status: "recovery" });
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
    eraseRecovery(active);
    input.setState({ status: "waiting" });
    yield* redeem({
      client: yield* input.webAuthClient,
      pairing: pairing.value,
      authenticated: input.authenticated,
    });
    clearAttempt(active);
  });
const eraseRecovery = (active: ActiveAttempt): void => {
  Option.map(active.recoveryElement, (element) => {
    element.textContent = "";
  });
  active.recoveryElement = Option.none();
  active.recovery = Option.none();
};

const guardedCommand =
  (input: Omit<ControllerInput, "setState">, active: ActiveAttempt) =>
  (
    notify: ControllerInput["setState"],
    work: (configured: ControllerInput) => Effect.Effect<void, CommandError>
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      const current = active.generation;
      const setState: ControllerInput["setState"] = (state) => {
        if (current === active.generation) notify(state);
      };
      return work({ ...input, setState }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause) || current !== active.generation) return Effect.void;
          return Effect.sync(() => {
            const state = failureState(active, cause);
            clearAttempt(active);
            notify(state);
          });
        })
      );
    });

/** Owns the private proof, popup and one-time recovery for one mounted authentication flow. */
export const makeProviderController = (
  input: Omit<ControllerInput, "setState">
): ProviderController => {
  const active: ActiveAttempt = {
    submission: Option.none(),
    pairing: Option.none(),
    popup: Option.none(),
    generation: 0,
    completionRequested: false,
    recovery: Option.none(),
    recoveryElement: Option.none(),
  };
  return {
    reservePopup: (): void => {
      if (Option.isSome(active.popup)) return;
      const popup = window.open("about:blank", "_blank", "popup,width=500,height=700");
      if (popup !== null) {
        popup.opener = null;
        active.popup = Option.some(popup);
      }
    },
    start: (submission, notify) =>
      Effect.suspend(() => {
        if (Option.isNone(active.popup)) return Effect.sync(() => notify({ status: "refused" }));
        active.completionRequested = false;
        active.submission = Option.some({ ...submission, popup: active.popup.value });
        return guardedCommand(input, active)(notify, (configured) =>
          executeStart(configured, active)
        );
      }),
    acknowledge: (notify) =>
      guardedCommand(input, active)(notify, (configured) =>
        executeAcknowledgement(configured, active)
      ),
    clear: () => clearAttempt(active),
    cancel: (): ProviderViewState => {
      const state: ProviderViewState = {
        status: active.completionRequested ? "uncertain" : "cancelled",
      };
      clearAttempt(active);
      return state;
    },
    revealRecovery: (element): void => {
      active.recoveryElement = Option.some(element);
      element.textContent = Option.match(active.recovery, {
        onNone: () => "",
        onSome: Redacted.value,
      });
    },
    concealRecovery: (element): void => {
      element.textContent = "";
    },
  };
};

export type ProviderController = Readonly<{
  reservePopup: () => void;
  start: (
    submission: Pick<Submission, "intent" | "revision">,
    notify: ControllerInput["setState"]
  ) => Effect.Effect<void>;
  acknowledge: (notify: ControllerInput["setState"]) => Effect.Effect<void>;
  cancel: () => ProviderViewState;
  clear: () => void;
  revealRecovery: (element: Element) => void;
  concealRecovery: (element: Element) => void;
}>;
