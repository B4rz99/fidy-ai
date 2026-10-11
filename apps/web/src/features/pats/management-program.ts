import { Effect, type Layer, Option, Queue, Stream } from "effect";
import { type AtomRegistry } from "effect/reactivity";
import { makeCanonicalRead } from "@/transport/canonical-read";
import { Command, Mount, Runtime, Subscription, type Update } from "foldkit";
import { mountElementProgram } from "@/browser/element-program";
import type { ActivePATList, FidyClient } from "@/transport/client";
import { managementView } from "./management-foldkit-view";
import {
  ManagementMessage as Message,
  ManagementModel as Model,
  Selection,
} from "./management-model";
import { mountManualPAT } from "./manual-program";

type Commands = Readonly<{
  Load: () => Command.Command<Message>;
  Revoke: (args: Readonly<{ selection: Selection }>) => Command.Command<Message>;
}>;
const makeCommands = <ReadError>(
  client: FidyClient,
  read: Effect.Effect<Readonly<{ data: ActivePATList }>, ReadError>
): Commands => ({
  Load: Command.define("LoadActivePATs", {
    messages: [Message.Loaded, Message.Failed],
    execute: read.pipe(
      Effect.map(({ data }) => Message.Loaded({ result: data })),
      Effect.catchCause(() => Effect.succeed(Message.Failed()))
    ),
  }),
  Revoke: Command.define("RevokePATs", {
    args: { selection: Selection },
    messages: [Message.Revoked, Message.RevokeFailed],
    execute: ({ selection }) =>
      Effect.gen(function* () {
        const api = yield* client;
        if (selection !== "all") {
          yield* api.pats.revokePAT({ params: { shortId: selection } });
          return Message.Revoked({ notice: "Token desactivado. Dejó de funcionar de inmediato." });
        }
        const response = yield* api.pats.revokeAllPATs({});
        const count = response.data.revokedCount;
        return Message.Revoked({
          notice:
            count === 1
              ? "Se desactivó 1 token activo."
              : `Se desactivaron ${count} tokens activos.`,
        });
      }).pipe(Effect.catchCause(() => Effect.succeed(Message.RevokeFailed()))),
  }),
});
const makeUpdate =
  ({
    Load,
    Revoke,
  }: Commands): ((model: Model, message: Message) => Update.Return<Model, Message>) =>
  (model, message) =>
    Message.match<Update.Return<Model, Message>>(message, {
      Loaded: ({ result }) => ({
        model: {
          ...model,
          result: Option.some(result),
          status: "Ready",
          uncertain: false,
          selection: Option.none(),
        },
      }),
      Failed: () => ({ model: { ...model, status: "Failed" } }),
      Refresh: () =>
        model.status === "Revoking" || model.status === "Loading"
          ? { model }
          : { model: { ...model, status: "Loading" }, commands: [Load()] },
      Select: ({ selection }) => ({
        model:
          model.status === "Ready" && !model.uncertain
            ? { ...model, selection: Option.some(selection), notice: "" }
            : model,
      }),
      Cancel: () => ({
        model: model.status === "Revoking" ? model : { ...model, selection: Option.none() },
      }),
      Confirm: () =>
        model.status === "Ready" && !model.uncertain && Option.isSome(model.selection)
          ? {
              model: { ...model, status: "Revoking" },
              commands: [Revoke({ selection: model.selection.value })],
            }
          : { model },
      Revoked: ({ notice }) => ({
        model: { ...model, notice, selection: Option.none(), status: "Loading" },
        commands: [Load()],
      }),
      RevokeFailed: () => ({
        model: {
          ...model,
          status: "Ready",
          uncertain: true,
          notice:
            "No pudimos confirmar la desactivación. Actualiza tus tokens antes de intentarlo de nuevo.",
        },
      }),
      Mounted: () => ({ model }),
    });
/** Owns active metadata, explicit revocation and a separately scoped one-time manual disclosure. */
export const mountPATManagement = (
  configuration: Readonly<{
    container: HTMLElement;
    client: FidyClient;
    registry: AtomRegistry.AtomRegistry;
    resources: Layer.Layer<never>;
  }>
): (() => void) => {
  const { container, client, registry, resources } = configuration;
  const query = makeCanonicalRead({ registry, query: client.query("pats", "listPATs", {}) });
  const commands = makeCommands(client, query.read);
  const events = Effect.runSync(Queue.unbounded<Message>());
  const children = new Set<() => void>();
  const manual = makeManualMount({ container, client, resources, events, children });
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      resources,
      devTools: false,
      init: (): Update.Return<Model, Message> => ({
        model: {
          result: Option.none(),
          status: "Loading",
          selection: Option.none(),
          notice: "",
          uncertain: false,
        },
        commands: [commands.Load()],
      }),
      update: makeUpdate(commands),
      view: (model, html) => managementView({ model, html, manual: manual() }),
      subscriptions: Subscription.make<Model, Message>()(() => ({
        changes: Subscription.persistent(Stream.fromQueue(events)),
      })),
      crash: {
        report: () => {
          for (const dispose of children) dispose();
        },
        view: (_, html) =>
          html.p([html.Role("alert")], ["No pudimos cargar tus tokens. Recarga la página."]),
      },
    })
  );
  return () => {
    for (const dispose of children) dispose();
    children.clear();
    handle.dispose();
    query.dispose();
    Effect.runSync(Queue.shutdown(events));
  };
};

const makeManualMount = (
  configuration: Readonly<{
    container: HTMLElement;
    client: FidyClient;
    resources: Layer.Layer<never>;
    events: Queue.Queue<Message>;
    children: Set<() => void>;
  }>
): (() => Mount.MountAction<Message>) => {
  const { container, client, resources, events, children } = configuration;
  return Mount.define("ManualPATProgram", {
    messages: [Message.Mounted],
    execute: ({ element }) => {
      if (!(element instanceof HTMLElement)) return Effect.succeed(Message.Mounted());
      return Effect.acquireRelease(
        Effect.sync(() => {
          element.id = `${container.id}-manual`;
          const dispose = mountElementProgram({
            host: element,
            mount: (target) =>
              mountManualPAT({
                container: target,
                client,
                resources,
                issued: () => {
                  Queue.offerUnsafe(events, Message.Refresh());
                },
              }),
          });
          children.add(dispose);
          return dispose;
        }),
        (dispose) =>
          Effect.sync(() => {
            children.delete(dispose);
            dispose();
          })
      ).pipe(Effect.as(Message.Mounted()));
    },
  });
};
