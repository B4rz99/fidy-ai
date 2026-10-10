import { Effect, type Layer, Option, Queue, Schema, Stream } from "effect";
import { Command, Mount, Runtime, Subscription, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  type AuthenticationProvider,
  PATPairingPublicCode,
  type WebAuthClient,
} from "@/transport/client";
import { type ProviderController, makeProviderController } from "./controller";
import { Intent, Message, Model, canContinue } from "./model";
import { view } from "./view";

type Configuration = Readonly<{
  provider: AuthenticationProvider;
  handoffReference: Option.Option<string>;
  cliCode: unknown;
  webAuthClient: WebAuthClient;
  resources: Layer.Layer<never>;
  authenticated: () => void;
}>;

const makeCommands = (
  controller: ProviderController,
  events: Queue.Queue<Message>,
  client: WebAuthClient
): Commands => {
  const publish =
    (attempt: number) =>
    (state: Model["state"]): void => {
      Queue.offerUnsafe(events, Message.ChangedAttempt({ attempt, state }));
    };
  const Start = Command.define("StartProviderAuthentication", {
    args: { intent: Intent, revision: Schema.String, attempt: Schema.Finite },
    messages: [Message.CompletedWork],
    interrupt: true,
    execute: ({ intent, revision, attempt }) =>
      controller
        .start({ intent, revision }, publish(attempt))
        .pipe(Effect.as(Message.CompletedWork())),
  });
  const Acknowledge = Command.define("AcknowledgeRecovery", {
    args: { attempt: Schema.Finite },
    messages: [Message.CompletedWork],
    interrupt: true,
    execute: ({ attempt }) =>
      controller.acknowledge(publish(attempt)).pipe(Effect.as(Message.CompletedWork())),
  });
  const Cancel = Command.define("CancelProviderAuthentication", {
    messages: [Message.CompletedCancellation],
    execute: Effect.gen(function* () {
      const state = yield* Effect.sync(controller.cancel);
      yield* Start.Interrupt(() => Message.CompletedWork()).effect;
      yield* Acknowledge.Interrupt(() => Message.CompletedWork()).effect;
      return Message.CompletedCancellation({ state });
    }),
  });
  const LoadDisclosure = Command.define("LoadSignupDisclosure", {
    messages: [Message.LoadedDisclosure],
    execute: Effect.gen(function* () {
      const api = yield* client;
      const disclosure = yield* api.providerAuthentication.disclosure();
      return Message.LoadedDisclosure({
        disclosure: {
          _tag: "Ready",
          revision: disclosure.revision,
          text: disclosure.text,
          policyUrl: disclosure.policy.publicUrl,
        },
      });
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed(Message.LoadedDisclosure({ disclosure: { _tag: "Failed" } }))
      )
    ),
  });
  return { Start, Acknowledge, Cancel, LoadDisclosure };
};
type Commands = Readonly<{
  Start: (
    args: Readonly<{ intent: typeof Intent.Type; revision: string; attempt: number }>
  ) => Command.Command<Message>;
  Acknowledge: (args: Readonly<{ attempt: number }>) => Command.Command<Message>;
  Cancel: () => Command.Command<Message>;
  LoadDisclosure: () => Command.Command<Message>;
}>;
type Updated = Update.Return<Model, Message>;

const startAttempt = (model: Model, commands: Commands): Updated => {
  const attempt = model.attempt + 1;
  return {
    model: { ...model, attempt, state: { status: "waiting" } },
    commands: [
      commands.Start({
        attempt,
        intent: model.intent,
        revision: model.disclosure._tag === "Ready" ? model.disclosure.revision : "",
      }),
    ],
  };
};

const makeUpdate =
  (commands: Commands, handoff: boolean) =>
  (model: Model, message: Message): Updated =>
    Message.match<Updated>(message, {
      ToggledIntent: () =>
        model.state.status === "editing"
          ? {
              model: {
                ...model,
                intent: model.intent === "signup" ? "login" : "signup",
                accepted: false,
              },
            }
          : { model },
      ToggledConsent: () => ({ model: { ...model, accepted: !model.accepted } }),
      ClickedContinue: () =>
        model.state.status === "editing" && canContinue({ model, handoff })
          ? startAttempt(model, commands)
          : { model },
      ClickedRetry: () =>
        model.state.status === "refused" || model.state.status === "cancelled"
          ? startAttempt(model, commands)
          : { model },
      ClickedCancel: () =>
        model.state.status === "waiting" || model.state.status === "confirming"
          ? {
              model: { ...model, attempt: model.attempt + 1, state: { status: "cancelling" } },
              commands: [commands.Cancel()],
            }
          : { model },
      CompletedCancellation: ({ state }) => ({ model: { ...model, state } }),
      ClickedAcknowledge: () =>
        model.state.status === "recovery"
          ? {
              model: { ...model, state: { status: "waiting" } },
              commands: [commands.Acknowledge({ attempt: model.attempt })],
            }
          : { model },
      ClickedRestart: () => ({
        model: {
          ...model,
          attempt: model.attempt + 1,
          intent: "login",
          accepted: false,
          state: { status: "editing" },
        },
      }),
      ClickedReloadDisclosure: () =>
        model.disclosure._tag === "Failed"
          ? {
              model: { ...model, accepted: false, disclosure: { _tag: "Loading" } },
              commands: [commands.LoadDisclosure()],
            }
          : { model },
      LoadedDisclosure: ({ disclosure }) => ({ model: { ...model, disclosure } }),
      ChangedAttempt: ({ attempt, state }) =>
        attempt === model.attempt ? { model: { ...model, state } } : { model },
      CompletedWork: () => ({ model }),
    });

const makeMounts = (controller: ProviderController): ViewMounts => ({
  // Reserve the blank popup inside the native gesture, before the asynchronous command queue.
  popup: Mount.define("ReserveProviderPopup", {
    messages: [Message.CompletedWork],
    execute: ({ element }) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          element.addEventListener("click", controller.reservePopup, true);
        }),
        () =>
          Effect.sync(() => {
            element.removeEventListener("click", controller.reservePopup, true);
          })
      ).pipe(Effect.as(Message.CompletedWork())),
  }),
  recovery: Mount.define("ShowOneTimeRecovery", {
    messages: [Message.CompletedWork],
    execute: ({ element }) =>
      Effect.acquireRelease(
        Effect.sync(() => controller.revealRecovery(element)),
        () => Effect.sync(() => controller.concealRecovery(element))
      ).pipe(Effect.as(Message.CompletedWork())),
  }),
});
type ViewMounts = Readonly<{
  popup: () => Mount.MountAction<Message>;
  recovery: () => Mount.MountAction<Message>;
}>;

const authenticationCrashView = (_: unknown, html: HtmlBuilder<never>): Html =>
  html.main(
    [],
    [
      html.p(
        [html.Role("alert")],
        ["No se completó el acceso. Recarga la página para iniciar un nuevo intento."]
      ),
    ]
  );

/** Mounts authentication; disposal immediately revokes private state and stops its work. */
export const mountProviderAuthentication = ({
  container,
  configuration,
}: Readonly<{ container: HTMLElement; configuration: Configuration }>): (() => void) => {
  const cliCode = Schema.decodeUnknownOption(PATPairingPublicCode)(configuration.cliCode);
  const destination = Option.match(cliCode, {
    onNone: () => "/app/transactions",
    onSome: (code) => `/connect/cli?cliCode=${encodeURIComponent(code)}`,
  });
  const controller = makeProviderController({
    ...configuration,
    authenticated: () => {
      configuration.authenticated();
      window.location.assign(destination);
    },
  });
  const events = Effect.runSync(Queue.sliding<Message>(1));
  const commands = makeCommands(controller, events, configuration.webAuthClient);
  const mounts = makeMounts(controller);
  const program = Runtime.makeElement({
    Model,
    container,
    resources: configuration.resources,
    devTools: false,
    init: (): Updated => ({
      model: {
        intent: "signup",
        accepted: false,
        disclosure: { _tag: "Loading" },
        state: { status: "editing" },
        attempt: 0,
      },
      commands: [commands.LoadDisclosure()],
    }),
    update: makeUpdate(commands, Option.isSome(configuration.handoffReference)),
    view: (model, html) =>
      view({ model, html, configuration: { ...configuration, cliCode, mounts } }),
    subscriptions: Subscription.make<Model, Message>()(() => ({
      attempt: Subscription.persistent(Stream.fromQueue(events)),
    })),
    crash: {
      report: () => controller.clear(),
      view: authenticationCrashView,
    },
  });
  const handle = Runtime.embed(program);
  return (): void => {
    controller.clear();
    handle.dispose();
    Effect.runSync(Queue.shutdown(events));
  };
};
