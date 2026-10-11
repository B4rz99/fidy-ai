import { Effect, type Layer, Queue, Stream } from "effect";
import { Command, Runtime, Subscription, type Update } from "foldkit";
import type { HostedTurnClient } from "@/transport/client";
import { makeConversationController } from "./controller";
import { Action, Message, Model } from "./model";
import { makeConversationMounts } from "./mounts";
import { conversationView } from "./view";

type AgentMount = Readonly<{
  container: HTMLElement;
  client: HostedTurnClient;
  resources: Layer.Layer<never>;
}>;
/** Owns the conversation for one authenticated layout; receipts never enter serializable state. */
export const mountHostedAgent = ({ container, client, resources }: AgentMount): (() => void) => {
  const events = Effect.runSync(Queue.unbounded<Message>());
  const controller = makeConversationController({
    client,
    changed: (view) => {
      Queue.offerUnsafe(events, Message.ChangedView({ view }));
    },
  });
  const mounts = makeConversationMounts({ controller, events });
  const Work = Command.define("HostedConversationWork", {
    args: { action: Action },
    messages: [Message.CompletedWork],
    execute: ({ action }) => controller.run(action).pipe(Effect.as(Message.CompletedWork())),
  });
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      resources,
      devTools: false,
      init: (): Update.Return<Model, Message> => ({
        model: { view: controller.initial, open: false, hasDraft: false },
      }),
      update: (model, message): Update.Return<Model, Message> =>
        Message.match<Update.Return<Model, Message>>(message, {
          ChangedView: ({ view }) => ({ model: { ...model, view, hasDraft: view.hasDraft } }),
          ChangedDraft: ({ present }) => ({ model: { ...model, hasDraft: present } }),
          ChangedOpen: ({ open }) => ({ model: { ...model, open } }),
          RequestedWork: ({ action }) =>
            action === "Visible" && !model.open
              ? { model }
              : { model, commands: [Work({ action })] },
          CompletedMount: () => ({ model }),
          CompletedWork: () => ({ model }),
        }),
      view: (model, html) => conversationView({ model, html, mounts }),
      subscriptions: Subscription.make<Model, Message>()(() => ({
        conversation: Subscription.persistent(Stream.fromQueue(events)),
      })),
      crash: {
        report: controller.dispose,
        view: (_, html) =>
          html.p(
            [html.Role("alert")],
            [
              "No pudimos confirmar el estado de la conversación. Revisa tus datos antes de intentarlo de nuevo.",
            ]
          ),
      },
    })
  );
  return () => {
    controller.dispose();
    handle.dispose();
    Effect.runSync(Queue.shutdown(events));
  };
};
