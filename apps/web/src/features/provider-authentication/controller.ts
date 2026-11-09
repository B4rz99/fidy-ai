import { destinationAfterLogin } from "@/session/login-destination";
import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Cause, Clock, type Context, DateTime, Effect, Option, Redacted } from "effect";
import { Atom } from "effect/reactivity";
import { type RefCallback, useCallback, useState } from "react";
import { useSession } from "@/session/session-context";
import {
  type AuthenticationProvider,
  type WebAuthClient,
  type WebAuthSuccess,
  fidyWhatsAppUrl,
} from "@/transport/client";

type Client = Context.Service.Shape<WebAuthClient>;
type Pairing = WebAuthSuccess<"browserLogin", "startPairing">;
type AssociationReview = Extract<
  WebAuthSuccess<"providerAuthentication", "status">,
  { status: "awaiting_association" }
>;
type WhatsAppReturn = NonNullable<
  WebAuthSuccess<"providerAuthentication", "complete">["whatsappReturnUrl"]
>;
type CommandError =
  | Effect.Error<ReturnType<Client["browserLogin"]["startPairing"]>>
  | Effect.Error<ReturnType<Client["providerAuthentication"]["start"]>>
  | "rejected"
  | "cancelled";
export type ProviderViewState =
  | Readonly<{ status: "editing" }>
  | Readonly<{ status: "waiting" }>
  | Readonly<{ status: "confirming"; code: string }>
  | Readonly<{ status: "associating"; review: AssociationReview }>
  | Readonly<{ status: "awaiting_chat" }>
  | Readonly<{ status: "recovery"; code: string }>
  | Readonly<{ status: "uncertain" }>
  | Readonly<{ status: "refused" }>
  | Readonly<{ status: "cancelled" }>;
type Submission = Readonly<{
  provider: AuthenticationProvider;
  intent: "signup" | "login";
  revision: string;
  popup: Window;
}>;
type RetryInput = Pick<Submission, "provider" | "intent" | "revision">;
const providerClient = (
  client: Client,
  provider: AuthenticationProvider
): Pick<Client["providerAuthentication"], "start" | "status" | "complete"> => {
  const api = client.providerAuthentication;
  return provider === "google"
    ? api
    : { start: api.startMicrosoft, status: api.statusMicrosoft, complete: api.completeMicrosoft };
};
type ProviderPoll = (
  client: Client,
  input: Readonly<{
    provider: AuthenticationProvider;
    pairing: Pairing;
    beforeRequest: Option.Option<() => void>;
  }>
) => Effect.Effect<
  WebAuthSuccess<"providerAuthentication", "status">,
  Effect.Error<ReturnType<Client["providerAuthentication"]["status"]>>
>;
/** One mounted owner preserves the server's five-per-five-seconds cadence across retries/phases. */
const makeProviderPoller = (): ProviderPoll => {
  const intervalMilliseconds = 1_000;
  let readyAt = 0;
  return (client, { provider, pairing, beforeRequest }): ReturnType<ProviderPoll> =>
    Effect.gen(function* () {
      const current = yield* Clock.currentTimeMillis;
      if (readyAt > current) yield* Effect.sleep(readyAt - current);
      readyAt = (yield* Clock.currentTimeMillis) + intervalMilliseconds;
      if (Option.isSome(beforeRequest)) beforeRequest.value();
      const result = yield* providerClient(client, provider).status({ payload: proof(pairing) });
      readyAt = (yield* Clock.currentTimeMillis) + intervalMilliseconds;
      return result;
    });
};
const withinPairingLifetime = <Value, Error>(
  pairing: Pairing,
  work: Effect.Effect<Value, Error>
): Effect.Effect<Value, Error | "rejected"> =>
  Effect.gen(function* () {
    const remaining = DateTime.toEpochMillis(pairing.expiresAt) - (yield* Clock.currentTimeMillis);
    if (remaining <= 0) return yield* Effect.fail("rejected" as const);
    return yield* work.pipe(
      Effect.timeoutOrElse({ duration: remaining, orElse: () => Effect.fail("rejected" as const) })
    );
  });
const awaitProviderVerification = (
  client: Client,
  pairing: Pairing,
  input: Pick<ControllerInput, "setState"> &
    Readonly<{
      popup: Window;
      provider: AuthenticationProvider;
      poll: ProviderPoll;
    }>
): Effect.Effect<Option.Option<AssociationReview>, "rejected" | "cancelled"> =>
  withinPairingLifetime(
    pairing,
    Effect.gen(function* () {
      for (;;) {
        let popupClosed = input.popup.closed;
        const observePopup = (): void => {
          popupClosed = input.popup.closed;
        };
        const result = yield* input
          .poll(client, {
            provider: input.provider,
            pairing,
            beforeRequest: Option.some(observePopup),
          })
          .pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              () => Effect.fail(input.popup.closed ? ("cancelled" as const) : ("rejected" as const))
            )
          );
        if (result.status === "verified") return Option.none();
        if (result.status === "awaiting_association") return Option.some(result);
        if (result.status === "awaiting_confirmation") {
          input.setState({ status: "confirming", code: result.associationCode });
        }
        if (result.status === "rejected") return yield* Effect.fail("rejected");
        if (result.status === "pending" && popupClosed) return yield* Effect.fail("cancelled");
      }
    })
  );

const proof = (
  pairing: Pairing
): Readonly<{
  pairingId: Pairing["pairingId"];
  privateVerifier: Redacted.Redacted.Value<Pairing["privateVerifier"]>;
}> => ({ pairingId: pairing.pairingId, privateVerifier: Redacted.value(pairing.privateVerifier) });
const redeem = (
  input: Readonly<{
    client: Client;
    pairing: Pairing;
    authenticated: (destination: Option.Option<WhatsAppReturn>) => void;
    destination: Option.Option<WhatsAppReturn>;
    isCurrent: () => boolean;
  }>
): Effect.Effect<void, "rejected"> =>
  input.client.browserLogin.redeemPairing({ payload: proof(input.pairing) }).pipe(
    Effect.mapError(() => "rejected" as const),
    Effect.flatMap((result) =>
      result.status === "authenticated"
        ? Effect.sync(() => {
            if (input.isCurrent()) input.authenticated(input.destination);
          })
        : Effect.fail("rejected" as const)
    )
  );

type AttemptCommand = Readonly<{ generation: number }>;
type AssociationCommand = AttemptCommand & Readonly<{ code: string }>;
type AttemptBinding = Readonly<{ generation: number; phase: ActiveAttempt["phase"] }>;
type ProviderController = Readonly<{
  start: Atom.AtomResultFn<AttemptCommand, void>;
  acknowledge: Atom.AtomResultFn<AttemptCommand, void>;
  approve: Atom.AtomResultFn<AssociationCommand, void>;
  clear: (restartable?: boolean) => void;
  cancellation: () => ProviderViewState;
  stage: (submission: Submission, binding: AttemptBinding) => boolean;
  binding: () => AttemptBinding;
  matches: (binding: AttemptBinding) => boolean;
  reserveStart: (binding: AttemptBinding) => Option.Option<AttemptBinding>;
  reserveApproval: (binding: AttemptBinding) => Option.Option<AttemptBinding>;
  reserveAcknowledgement: (binding: AttemptBinding) => boolean;
  attach: () => void;
  show: ControllerInput["setState"];
}>;
type ControllerInput = Readonly<{
  webAuthClient: WebAuthClient;
  setState: (state: ProviderViewState) => void;
  authenticated: (destination: Option.Option<WhatsAppReturn>) => void;
  handoffReference: Option.Option<string>;
}>;
type ActiveAttempt = {
  phase: ProviderViewState["status"] | "starting" | "disposed";
  submission: Option.Option<Submission>;
  pairing: Option.Option<Pairing>;
  popup: Option.Option<Window>;
  generation: number;
  completionRequested: boolean;
  destination: Option.Option<WhatsAppReturn>;
  provider: AuthenticationProvider;
  poll: ProviderPoll;
};
/** Isolated external provider windows must close themselves or be closed by the User. */
const closeProviderPopup = (popup: Window): void => {
  if (popup.closed) return;
  let location: string;
  try {
    location = popup.location.href;
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "SecurityError") return;
    throw cause;
  }
  if (location === "about:blank" || new URL(location).origin === window.location.origin) {
    popup.close();
  }
};
const clearAttempt = (
  active: ActiveAttempt,
  pairing: Option.Option<Pairing> = Option.none()
): void => {
  active.generation += 1;
  active.phase = "disposed";
  active.submission = Option.none();
  active.pairing = pairing;
  active.destination = Option.none();
  Option.map(active.popup, closeProviderPopup);
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
const requireCurrentAttempt = (active: ActiveAttempt, generation: number): Effect.Effect<void> =>
  active.generation === generation ? Effect.void : Effect.interrupt;
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
    yield* requireCurrentAttempt(active, current);
    const started = Option.isSome(active.pairing)
      ? active.pairing.value
      : yield* client.browserLogin.startPairing();
    yield* requireCurrentAttempt(active, current);
    active.pairing = Option.some(started);
    const authorization = yield* providerClient(client, staged.value.provider).start({
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
    yield* requireCurrentAttempt(active, current);
    yield* navigateProviderPopup(staged.value.popup, authorization.authorizationUrl);
    const review = yield* awaitProviderVerification(client, started, {
      ...input,
      setState: (state) => {
        if (active.generation === current) input.setState(state);
      },
      provider: staged.value.provider,
      popup: staged.value.popup,
      poll: active.poll,
    });
    yield* requireCurrentAttempt(active, current);
    closeProviderPopup(staged.value.popup);
    if (Option.isSome(review)) {
      input.setState({ status: "associating", review: review.value });
      return;
    }
    yield* executeCompletion(input, active, Option.none());
  });
const executeCompletion = (
  input: ControllerInput,
  active: ActiveAttempt,
  associationCode: Option.Option<string>
): Effect.Effect<void, CommandError> =>
  Effect.gen(function* () {
    const pairing = active.pairing;
    if (Option.isNone(pairing) || active.completionRequested) return;
    const current = active.generation;
    input.setState({ status: "waiting" });
    const client = yield* input.webAuthClient;
    if (active.generation !== current) return;
    if (active.completionRequested) return;
    const provider = active.provider;
    active.completionRequested = true;
    const result = yield* providerClient(client, provider).complete({
      payload: {
        ...proof(pairing.value),
        ...Option.match(associationCode, {
          onNone: () => ({}),
          onSome: (code) => ({ associationCode: code }),
        }),
      },
    });
    if (active.generation !== current) return;
    active.destination = Option.fromUndefinedOr(result.whatsappReturnUrl);
    if (result.status === "created") {
      input.setState({ status: "recovery", code: Redacted.value(result.backupRecoveryCode) });
    } else {
      yield* redeem({
        client,
        pairing: pairing.value,
        authenticated: input.authenticated,
        destination: active.destination,
        isCurrent: () => active.generation === current,
      });
      if (active.generation === current) clearAttempt(active);
    }
  });
const awaitChatApproval = (
  input: ControllerInput,
  active: ActiveAttempt,
  code: string
): Effect.Effect<void, CommandError> =>
  Effect.gen(function* () {
    const pairing = active.pairing;
    if (Option.isNone(pairing)) return;
    const current = active.generation;
    input.setState({ status: "awaiting_chat" });
    const client = yield* input.webAuthClient;
    if (active.generation !== current) return;
    yield* withinPairingLifetime(
      pairing.value,
      Effect.gen(function* () {
        for (;;) {
          const result = yield* active
            .poll(client, {
              provider: active.provider,
              pairing: pairing.value,
              beforeRequest: Option.none(),
            })
            .pipe(Effect.mapError(() => "rejected" as const));
          if (active.generation !== current) return;
          if (result.status === "verified") break;
          if (result.status !== "awaiting_association" || result.associationCode !== code) {
            return yield* Effect.fail("rejected" as const);
          }
        }
        if (active.generation === current) {
          yield* executeCompletion(input, active, Option.some(code));
        }
      })
    );
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
    const current = active.generation;
    const client = yield* input.webAuthClient;
    if (active.generation !== current) return;
    input.setState({ status: "waiting" });
    yield* redeem({
      client,
      pairing: pairing.value,
      authenticated: input.authenticated,
      destination: active.destination,
      isCurrent: () => active.generation === current,
    });
    if (active.generation === current) clearAttempt(active);
  });
const guardedCommand = <Value extends AttemptCommand>(
  input: ControllerInput,
  active: ActiveAttempt,
  command: (value: Value) => Effect.Effect<void, CommandError>
): Atom.AtomResultFn<Value, void> =>
  input.webAuthClient.runtime.fn<Value>()(
    (value) => {
      const current = value.generation;
      if (active.generation !== current) return Effect.void;
      return command(value).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) || active.generation !== current
            ? Effect.void
            : Effect.sync(() => {
                const state = failureState(active, cause);
                clearAttempt(
                  active,
                  Option.isSome(input.handoffReference) && !active.completionRequested
                    ? active.pairing
                    : Option.none()
                );
                input.setState(state);
              })
        )
      );
    },
    { concurrent: false }
  );
const refuseExpiredAttempt = (input: ControllerInput, active: ActiveAttempt): boolean => {
  if (
    Option.isNone(active.pairing) ||
    DateTime.toEpochMillis(active.pairing.value.expiresAt) > Date.now()
  ) {
    return false;
  }
  const state: ProviderViewState = {
    status: active.completionRequested ? "uncertain" : "refused",
  };
  clearAttempt(
    active,
    Option.isSome(input.handoffReference) && !active.completionRequested
      ? active.pairing
      : Option.none()
  );
  input.setState(state);
  return true;
};
const providerAdmission = (
  input: ControllerInput,
  active: ActiveAttempt
): Pick<
  ProviderController,
  "binding" | "matches" | "show" | "reserveApproval" | "reserveAcknowledgement" | "reserveStart"
> => {
  const matches = (binding: AttemptBinding): boolean =>
    active.generation === binding.generation && active.phase === binding.phase;
  return {
    binding: () => ({ generation: active.generation, phase: active.phase }),
    matches,
    show: input.setState,
    reserveApproval: (binding) => {
      if (
        !matches(binding) ||
        active.phase !== "associating" ||
        refuseExpiredAttempt(input, active)
      ) {
        return Option.none();
      }
      input.setState({ status: "awaiting_chat" });
      return Option.some({ generation: active.generation, phase: active.phase });
    },
    reserveAcknowledgement: (binding) => {
      if (!matches(binding) || active.phase !== "recovery" || refuseExpiredAttempt(input, active)) {
        return false;
      }
      input.setState({ status: "waiting" });
      return true;
    },
    reserveStart: (binding) => {
      if (!matches(binding) || refuseExpiredAttempt(input, active)) return Option.none();
      if (
        active.phase !== "editing" &&
        active.phase !== "refused" &&
        active.phase !== "cancelled"
      ) {
        return Option.none();
      }
      clearAttempt(
        active,
        Option.isSome(input.handoffReference) && !active.completionRequested
          ? active.pairing
          : Option.none()
      );
      active.completionRequested = false;
      active.phase = "starting";
      return Option.some({ generation: active.generation, phase: active.phase });
    },
  };
};
const makeProviderController = (originalInput: ControllerInput): ProviderController => {
  const active: ActiveAttempt = {
    phase: "editing",
    submission: Option.none(),
    pairing: Option.none(),
    popup: Option.none(),
    generation: 0,
    completionRequested: false,
    destination: Option.none(),
    provider: "google",
    poll: makeProviderPoller(),
  };
  const input: ControllerInput = {
    ...originalInput,
    setState: (state) => {
      active.phase = state.status;
      originalInput.setState(state);
    },
  };
  const admission = providerAdmission(input, active);
  return {
    ...admission,
    attach: () => {
      if (active.phase === "disposed") input.setState({ status: "editing" });
    },
    start: guardedCommand(input, active, () => executeStart(input, active)),
    acknowledge: guardedCommand(input, active, () => executeAcknowledgement(input, active)),
    approve: guardedCommand(input, active, ({ code }: AssociationCommand) =>
      awaitChatApproval(input, active, code)
    ),
    clear: (restartable = false) =>
      clearAttempt(
        active,
        restartable && Option.isSome(input.handoffReference) && !active.completionRequested
          ? active.pairing
          : Option.none()
      ),
    cancellation: () => ({ status: active.completionRequested ? "uncertain" : "cancelled" }),
    stage: (value, binding) => {
      if (!admission.matches(binding) || active.phase !== "starting") return false;
      active.submission = Option.some(value);
      active.provider = value.provider;
      active.popup = Option.some(value.popup);
      return true;
    },
  };
};

/** Owns one mounted Provider attempt; proofs and recovery are discarded on navigation or restart. */
type ProviderAuthentication = Readonly<{
  state: ProviderViewState;
  provider: AuthenticationProvider;
  mounted: RefCallback<HTMLElement>;
  start: (provider: AuthenticationProvider, intent: "signup" | "login", revision: string) => void;
  retry: () => void;
  restart: () => void;
  cancel: () => void;
  acknowledge: () => void;
  approve: () => void;
}>;
const startProvider = ({
  controller,
  runStart,
  binding,
  provider,
  intent,
  revision,
}: Readonly<{
  controller: ProviderController;
  runStart: (value: AttemptCommand) => void;
  binding: AttemptBinding;
}> &
  Pick<Submission, "provider" | "intent" | "revision">): boolean => {
  const reservation = controller.reserveStart(binding);
  if (Option.isNone(reservation)) return false;
  const popup = window.open("about:blank", "_blank", "popup,width=500,height=700");
  if (popup === null) {
    if (!controller.matches(reservation.value)) return false;
    controller.show({ status: "refused" });
    return true;
  }
  popup.opener = null;
  if (!controller.stage({ provider, intent, revision, popup }, reservation.value)) {
    closeProviderPopup(popup);
    return false;
  }
  runStart({ generation: reservation.value.generation });
  return true;
};
type ProviderCommands = Readonly<{
  runStart: (value: AttemptCommand | typeof Atom.Interrupt) => void;
  runAcknowledgement: (value: AttemptCommand | typeof Atom.Interrupt) => void;
  runApproval: (value: AssociationCommand | typeof Atom.Interrupt) => void;
  clear: (restartable?: boolean) => void;
  mounted: RefCallback<HTMLElement>;
}>;
const useProviderCommands = (controller: ProviderController): ProviderCommands => {
  const runStart = useAtomSet(controller.start);
  const runAcknowledgement = useAtomSet(controller.acknowledge);
  const runApproval = useAtomSet(controller.approve);
  const clear = useCallback(
    (restartable = false): void => {
      controller.clear(restartable);
      runStart(Atom.Interrupt);
      runAcknowledgement(Atom.Interrupt);
      runApproval(Atom.Interrupt);
    },
    [controller, runStart, runAcknowledgement, runApproval]
  );
  const mounted = useCallback(
    (node: Parameters<RefCallback<HTMLElement>>[0]) => {
      if (node === null) return;
      controller.attach();
      return (): void => clear();
    },
    [clear, controller]
  );
  return { runStart, runAcknowledgement, runApproval, clear, mounted };
};
const openWhatsAppConfirmation = (text: string): void => {
  const destination = new URL(fidyWhatsAppUrl);
  destination.searchParams.set("text", text);
  window.open(destination.href, "_blank", "noopener,noreferrer");
};
const approveAssociation = ({
  controller,
  binding,
  review,
  runApproval,
}: Readonly<{
  controller: ProviderController;
  binding: AttemptBinding;
  review: AssociationReview;
  runApproval: ProviderCommands["runApproval"];
}>): void => {
  const reservation = controller.reserveApproval(binding);
  if (Option.isNone(reservation)) return;
  openWhatsAppConfirmation(review.confirmationText);
  if (controller.matches(reservation.value)) {
    runApproval({ generation: reservation.value.generation, code: review.associationCode });
  }
};
const providerActions = ({
  controller,
  state,
  retryInput,
  setRetryInput,
  runStart,
  runAcknowledgement,
  runApproval,
  clear,
  mounted,
}: Readonly<{
  controller: ProviderController;
  state: ProviderViewState;
  retryInput: Option.Option<RetryInput>;
  setRetryInput: (input: Option.Option<RetryInput>) => void;
}> &
  ProviderCommands): ProviderAuthentication => {
  const binding = controller.binding();
  const start: ProviderAuthentication["start"] = (provider, intent, revision) => {
    if (startProvider({ controller, runStart, binding, provider, intent, revision })) {
      setRetryInput(Option.some({ provider, intent, revision }));
    }
  };
  return {
    state,
    provider: Option.match(retryInput, {
      onNone: () => "google",
      onSome: (input) => input.provider,
    }),
    mounted,
    start,
    retry: (): void => {
      if (state.status !== "refused" && state.status !== "cancelled") return;
      Option.map(retryInput, ({ provider, intent, revision }) => start(provider, intent, revision));
    },
    cancel: (): void => {
      if (!controller.matches(binding)) return;
      const cancellation = controller.cancellation();
      clear(true);
      controller.show(cancellation);
    },
    restart: (): void => {
      if (!controller.matches(binding)) return;
      clear(true);
      setRetryInput(Option.none());
      controller.show({ status: "editing" });
    },
    acknowledge: (): void => {
      if (controller.reserveAcknowledgement(binding)) {
        runAcknowledgement({ generation: binding.generation });
      }
    },
    approve: (): void => {
      if (state.status === "associating") {
        approveAssociation({ controller, binding, review: state.review, runApproval });
      }
    },
  };
};
export const useProviderAuthentication = ({
  handoffReference,
}: Readonly<{
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
      handoffReference,
      authenticated: (destination) => {
        session.completeLogin();
        window.location.assign(
          Option.getOrElse(destination, () => destinationAfterLogin(router.state.location.search))
        );
      },
    })
  );
  const { runStart, runAcknowledgement, runApproval, clear, mounted } =
    useProviderCommands(controller);
  return providerActions({
    controller,
    state,
    retryInput,
    setRetryInput,
    runStart,
    runAcknowledgement,
    runApproval,
    clear,
    mounted,
  });
};

export const closeProviderReturn = (node: Parameters<RefCallback<HTMLElement>>[0]): void => {
  if (node === null) return;
  window.close();
};
