import { Effect, type Layer, Option, Queue, Schema, Stream } from "effect";
import { Command, Mount, Runtime, Subscription, type Update } from "foldkit";
import { type PrivateInputs, makePrivateInputs } from "@/browser/private-inputs";
import { EmailAddress, EmailVerificationCode, type WebAuthClient } from "@/transport/client";
import {
  type BrowserLoginPairingController,
  makeBrowserLoginPairingController,
} from "./controller";
import { EmailAction, Message, Model, type PairingState } from "./model";
import { pairingView } from "./view";

type Inputs = PrivateInputs<"email" | "proof">;
type PairingMount = Readonly<{
  container: HTMLElement;
  client: WebAuthClient;
  resources: Layer.Layer<never>;
  authenticated: () => void;
  loggedOut: () => void;
  restart: () => void;
  signedIn: boolean;
  providerUrl: string;
}>;
const emailOperation = (
  action: EmailAction,
  inputs: Inputs,
  controller: BrowserLoginPairingController
): boolean => {
  if (action === "Resend") return controller.stageResend();
  if (action === "Request") {
    const email = Schema.decodeOption(EmailAddress)(inputs.read("email"));
    if (Option.isNone(email)) return false;
    controller.stageEmail(email.value);
    inputs.clear("email");
    return true;
  }
  const proof = Schema.decodeOption(EmailVerificationCode)(
    inputs.read("proof").trim().toUpperCase()
  );
  inputs.clear("proof");
  if (Option.isNone(proof)) return false;
  controller.stageCombinedCode(proof.value);
  return true;
};
type Callbacks = Readonly<{
  state: (state: PairingState) => void;
  authenticated: () => void;
  loggedOut: () => void;
  restart: () => void;
}>;
type Commands = Readonly<{
  Start: () => Command.Command<Message>;
  Email: (args: Readonly<{ action: EmailAction }>) => Command.Command<Message>;
  Logout: () => Command.Command<Message>;
  Restart: () => Command.Command<Message>;
}>;
const makeCommands = (
  controller: BrowserLoginPairingController,
  inputs: Inputs,
  callbacks: Callbacks
): Commands => {
  let emailBusy = false;
  return {
    Start: Command.define("StartBrowserPairing", {
      messages: [Message.CompletedWork],
      interrupt: true,
      execute: controller
        .startPairing({ onAuthenticated: callbacks.authenticated, onStateChange: callbacks.state })
        .pipe(Effect.as(Message.CompletedWork())),
    }),
    Email: Command.define("ApproveBrowserPairingEmail", {
      args: { action: EmailAction },
      messages: [Message.CompletedWork],
      execute: ({ action }) =>
        Effect.gen(function* () {
          if (emailBusy || !emailOperation(action, inputs, controller)) {
            return Message.CompletedWork();
          }
          emailBusy = true;
          const command = { onStateChange: callbacks.state };
          yield* (
            action === "Complete"
              ? controller.completeEmail(command)
              : controller.requestEmail(command)
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                emailBusy = false;
              })
            )
          );
          return Message.CompletedWork();
        }),
    }),
    Logout: Command.define("LogoutPairedBrowser", {
      messages: [Message.CompletedWork],
      execute: controller
        .logout({ onLoggedOut: callbacks.loggedOut })
        .pipe(Effect.as(Message.CompletedWork())),
    }),
    Restart: Command.define("RestartBrowserPairing", {
      messages: [Message.CompletedWork],
      execute: Effect.sync(() => {
        controller.clear();
        inputs.clear("email");
        inputs.clear("proof");
        callbacks.restart();
        return Message.CompletedWork();
      }),
    }),
  };
};
const emailAllowed = (state: PairingState, action: EmailAction): boolean => {
  if (state._tag !== "AwaitingApproval") return false;
  if (state.emailStep === "sending" || state.emailStep === "submitting") return false;
  if (action === "Request") return state.emailStep === "ready";
  return state.emailStep === "code" || state.emailStep === "rejected";
};
const makeUpdate =
  ({
    Start,
    Email,
    Logout,
    Restart,
  }: Commands): ((model: Model, message: Message) => Update.Return<Model, Message>) =>
  (model, message) =>
    Message.match<Update.Return<Model, Message>>(message, {
      ChangedState: ({ state }) => ({ model: { state } }),
      ClickedStart: () =>
        model.state._tag === "Idle"
          ? { model: { state: { _tag: "Starting" } }, commands: [Start()] }
          : { model },
      ClickedRestart: () => ({ model: { state: { _tag: "Idle" } }, commands: [Restart()] }),
      ClickedLogout: () =>
        model.state._tag === "Authenticated" ? { model, commands: [Logout()] } : { model },
      RequestedEmail: ({ action }) =>
        emailAllowed(model.state, action) ? { model, commands: [Email({ action })] } : { model },
      CompletedWork: () => ({ model }),
      CompletedMount: () => ({ model }),
    });
const makeInputMount = (
  inputs: Inputs
): ((args: Readonly<{ field: "email" | "proof" }>) => Mount.MountAction<Message>) =>
  Mount.define("PrivateBrowserPairingInput", {
    args: { field: Schema.Literals(["email", "proof"]) },
    messages: [Message.CompletedMount],
    execute: ({ element, field }) => {
      if (!(element instanceof HTMLInputElement)) return Effect.succeed(Message.CompletedMount());
      return Effect.acquireRelease(
        Effect.sync(() => inputs.bind(field, element)),
        (release) => Effect.sync(release)
      ).pipe(Effect.as(Message.CompletedMount()));
    },
  });
/** Starts polling only on explicit intent and retains verifier and email proofs in scoped capabilities. */
export const mountBrowserPairing = (configuration: PairingMount): (() => void) => {
  const { container, client, resources, signedIn, providerUrl } = configuration;
  const events = Effect.runSync(Queue.unbounded<Message>());
  const inputs = makePrivateInputs<"email" | "proof">();
  const controller = makeBrowserLoginPairingController(client);
  let active = true;
  const commands = makeCommands(controller, inputs, {
    state: (state) => {
      if (active) Queue.offerUnsafe(events, Message.ChangedState({ state }));
    },
    authenticated: () => {
      if (active) configuration.authenticated();
    },
    loggedOut: () => {
      if (active) configuration.loggedOut();
    },
    restart: configuration.restart,
  });
  const input = makeInputMount(inputs);
  const disposePrivate = (): void => {
    active = false;
    controller.clear();
    inputs.dispose();
  };
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      resources,
      devTools: false,
      init: (): Update.Return<Model, Message> => ({
        model: { state: { _tag: signedIn ? "Authenticated" : "Idle" } },
      }),
      update: makeUpdate(commands),
      view: (model, html) => pairingView({ state: model.state, html, input, providerUrl }),
      subscriptions: Subscription.make<Model, Message>()(() => ({
        state: Subscription.persistent(Stream.fromQueue(events)),
      })),
      crash: {
        report: disposePrivate,
        view: (_, html) =>
          html.p(
            [html.Role("alert")],
            ["No pudimos confirmar la vinculación. Recarga la página antes de intentarlo de nuevo."]
          ),
      },
    })
  );
  return () => {
    disposePrivate();
    handle.dispose();
    Effect.runSync(Queue.shutdown(events));
  };
};
