import { destinationAfterLogin } from "@/session/login-destination";
import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Cause, type Context, Effect, Option, Redacted } from "effect";
import { Atom } from "effect/reactivity";
import { type RefCallback, useCallback, useState } from "react";
import { useSession } from "@/session/session-context";
import type { AuthenticationProvider, WebAuthClient, WebAuthSuccess } from "@/transport/client";

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
const awaitProviderVerification = (
  client: Client,
  pairing: Pairing,
  input: Pick<ControllerInput, "setState"> &
    Readonly<{ popup: Window; provider: AuthenticationProvider }>
): Effect.Effect<Option.Option<AssociationReview>, "rejected" | "cancelled"> =>
  Effect.gen(function* () {
    for (;;) {
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
      if (result.status === "verified") return Option.none();
      if (result.status === "awaiting_association") return Option.some(result);
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
  input: Readonly<{
    client: Client;
    pairing: Pairing;
    authenticated: (destination: Option.Option<WhatsAppReturn>) => void;
    destination: Option.Option<WhatsAppReturn>;
  }>
): Effect.Effect<void, "rejected"> =>
  input.client.browserLogin.redeemPairing({ payload: proof(input.pairing) }).pipe(
    Effect.mapError(() => "rejected" as const),
    Effect.flatMap((result) =>
      result.status === "authenticated"
        ? Effect.sync(() => input.authenticated(input.destination))
        : Effect.fail("rejected" as const)
    )
  );

type ProviderController = Readonly<{
  start: Atom.AtomResultFn<void, void>;
  acknowledge: Atom.AtomResultFn<void, void>;
  approve: Atom.AtomResultFn<string, void>;
  clear: (restartable?: boolean) => void;
  cancellation: () => ProviderViewState;
  stage: (submission: Submission) => void;
}>;
type ControllerInput = Readonly<{
  webAuthClient: WebAuthClient;
  setState: (state: ProviderViewState) => void;
  authenticated: (destination: Option.Option<WhatsAppReturn>) => void;
  handoffReference: Option.Option<string>;
}>;
type ActiveAttempt = {
  submission: Option.Option<Submission>;
  pairing: Option.Option<Pairing>;
  popup: Option.Option<Window>;
  generation: number;
  completionRequested: boolean;
  destination: Option.Option<WhatsAppReturn>;
  provider: AuthenticationProvider;
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
    const started = Option.isSome(active.pairing)
      ? active.pairing.value
      : yield* client.browserLogin.startPairing();
    if (active.generation !== current) {
      return;
    }
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
    if (active.generation !== current) {
      return;
    }
    yield* navigateProviderPopup(staged.value.popup, authorization.authorizationUrl);
    const review = yield* awaitProviderVerification(client, started, {
      ...input,
      provider: staged.value.provider,
      popup: staged.value.popup,
    });
    closeProviderPopup(staged.value.popup);
    if (active.generation !== current) {
      return;
    }
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
    if (Option.isNone(pairing)) return;
    const current = active.generation;
    input.setState({ status: "waiting" });
    active.completionRequested = true;
    const client = yield* input.webAuthClient;
    const provider = active.provider;
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
      });
      clearAttempt(active);
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
    input.setState({ status: "awaiting_chat" });
    const client = yield* input.webAuthClient;
    for (;;) {
      const result = yield* providerClient(client, active.provider)
        .status({ payload: proof(pairing.value) })
        .pipe(Effect.mapError(() => "rejected" as const));
      if (result.status === "verified") break;
      if (result.status !== "awaiting_association" || result.associationCode !== code) {
        return yield* Effect.fail("rejected" as const);
      }
      yield* Effect.sleep("1 second");
    }
    yield* executeCompletion(input, active, Option.some(code));
  }).pipe(
    Effect.timeout("10 minutes"),
    Effect.mapError(() => "rejected" as const)
  );

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
      destination: active.destination,
    });
    clearAttempt(active);
  });
const guardedCommand = <Value = void>(
  input: ControllerInput,
  active: ActiveAttempt,
  command: (value: Value) => Effect.Effect<void, CommandError>
): Atom.AtomResultFn<Value, void> =>
  input.webAuthClient.runtime.fn<Value>()(
    (value) => {
      const current = active.generation;
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
const makeProviderController = (input: ControllerInput): ProviderController => {
  const active: ActiveAttempt = {
    submission: Option.none(),
    pairing: Option.none(),
    popup: Option.none(),
    generation: 0,
    completionRequested: false,
    destination: Option.none(),
    provider: "google",
  };
  return {
    start: guardedCommand(input, active, () => executeStart(input, active)),
    acknowledge: guardedCommand(input, active, () => executeAcknowledgement(input, active)),
    approve: guardedCommand(input, active, (code: string) =>
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
    stage: (value: Submission): void => {
      clearAttempt(
        active,
        Option.isSome(input.handoffReference) && !active.completionRequested
          ? active.pairing
          : Option.none()
      );
      active.completionRequested = false;
      active.submission = Option.some(value);
      active.provider = value.provider;
      active.popup = Option.some(value.popup);
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
  setState,
  provider,
  intent,
  revision,
}: Readonly<{
  controller: ProviderController;
  runStart: (value: void) => void;
  setState: ControllerInput["setState"];
}> &
  Pick<Submission, "provider" | "intent" | "revision">): void => {
  const popup = window.open("about:blank", "_blank", "popup,width=500,height=700");
  if (popup === null) {
    setState({ status: "refused" });
    return;
  }
  popup.opener = null;
  controller.stage({ provider, intent, revision, popup });
  runStart(undefined);
};
type ProviderCommands = Readonly<{
  runStart: (value: void | typeof Atom.Interrupt) => void;
  runAcknowledgement: (value: void | typeof Atom.Interrupt) => void;
  runApproval: (value: string | typeof Atom.Interrupt) => void;
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
    (node: Parameters<RefCallback<HTMLElement>>[0]) =>
      node !== null ? (): void => clear() : undefined,
    [clear]
  );
  return { runStart, runAcknowledgement, runApproval, clear, mounted };
};
const openWhatsAppConfirmation = (text: string): void => {
  const destination = new URL("https://wa.me/12056871742");
  destination.searchParams.set("text", text);
  window.open(destination.href, "_blank", "noopener,noreferrer");
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
  const start: ProviderAuthentication["start"] = (provider, intent, revision) => {
    setRetryInput(Option.some({ provider, intent, revision }));
    startProvider({ controller, runStart, setState, provider, intent, revision });
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
      const cancellation = controller.cancellation();
      clear(true);
      setState(cancellation);
    },
    restart: (): void => {
      clear(true);
      setRetryInput(Option.none());
      setState({ status: "editing" });
    },
    acknowledge: (): void => runAcknowledgement(undefined),
    approve: (): void => {
      if (state.status === "associating") {
        openWhatsAppConfirmation(state.review.confirmationText);
        runApproval(state.review.associationCode);
      }
    },
  };
};

export const closeProviderReturn = (node: Parameters<RefCallback<HTMLElement>>[0]): void => {
  if (node === null) return;
  window.close();
};
