import { Effect, type Layer, Option, Schema } from "effect";
import { Command, Runtime, type Update } from "foldkit";
import { OAuthConnectionId, type WebAuthClient } from "@/transport/client";
import { Message, Model } from "./management-model";
import { managementView } from "./management-foldkit-view";

type Commands = Readonly<{
  Load: () => Command.Command<Message>;
  Revoke: (args: Readonly<{ id: Option.Option<OAuthConnectionId> }>) => Command.Command<Message>;
}>;
const makeCommands = (
  client: WebAuthClient,
  after: Option.Option<OAuthConnectionId>
): Commands => ({
  Load: Command.define("LoadConnectedAgents", {
    messages: [Message.Loaded, Message.LoadFailed],
    execute: client.pipe(
      Effect.flatMap((api) => api.oauthConnections.list({ query: { after } })),
      Effect.map((list) => Message.Loaded({ list })),
      Effect.catchCause(() => Effect.succeed(Message.LoadFailed()))
    ),
  }),
  Revoke: Command.define("RevokeConnectedAgents", {
    args: { id: Schema.Option(OAuthConnectionId) },
    messages: [Message.Revoked, Message.RevocationUncertain],
    execute: ({ id }) =>
      client.pipe(
        Effect.flatMap((api) =>
          Option.match(id, {
            onNone: () => api.oauthConnections.revokeAll({ payload: {} }),
            onSome: (connectionId) => api.oauthConnections.revoke({ payload: { connectionId } }),
          })
        ),
        Effect.as(Message.Revoked()),
        Effect.catchCause(() => Effect.succeed(Message.RevocationUncertain()))
      ),
  }),
});
const makeUpdate =
  ({
    Load,
    Revoke,
  }: Commands): ((model: Model, message: Message) => Update.Return<Model, Message>) =>
  (model, message) =>
    Message.match<Update.Return<Model, Message>>(message, {
      Loaded: ({ list }) => ({
        model: {
          ...model,
          list: Option.some(list),
          status: "Ready",
          revocation: model.revocation === "Uncertain" ? "None" : model.revocation,
        },
      }),
      LoadFailed: () => ({ model: { ...model, status: "Failed" } }),
      ClickedRefresh: () =>
        model.status === "Revoking" || model.status === "Loading"
          ? { model }
          : { model: { ...model, status: "Loading" }, commands: [Load()] },
      ClickedRevoke: ({ id }) =>
        model.status !== "Ready" || model.revocation === "Uncertain"
          ? { model }
          : {
              model: { ...model, status: "Revoking", revocation: "None" },
              commands: [Revoke({ id })],
            },
      Revoked: () => ({
        model: { ...model, status: "Loading", revocation: "Succeeded" },
        commands: [Load()],
      }),
      RevocationUncertain: () => ({
        model: { ...model, status: "Ready", revocation: "Uncertain" },
      }),
    });
/** Owns one canonical listing and revocation lifecycle, scoped to its route and account. */
const mountManagement = (
  {
    container,
    client,
    resources,
    after,
  }: Readonly<{
    container: HTMLElement;
    client: WebAuthClient;
    resources: Layer.Layer<never>;
    after: Option.Option<OAuthConnectionId>;
  }>,
  presentation: "Standalone" | "Access"
): (() => void) => {
  const commands = makeCommands(client, after);
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      resources,
      devTools: false,
      init: (): Update.Return<Model, Message> => ({
        model: { list: Option.none(), status: "Loading", revocation: "None" },
        commands: [commands.Load()],
      }),
      update: makeUpdate(commands),
      view: (model, html) => managementView({ model, html, after, presentation }),
      crash: {
        view: (_, html) =>
          html.p(
            [html.Role("alert")],
            ["No pudimos confirmar el estado de tus agentes. Recarga la página."]
          ),
      },
    })
  );
  return () => handle.dispose();
};

export const mountOAuthManagement = (
  configuration: Parameters<typeof mountManagement>[0]
): (() => void) => mountManagement(configuration, "Standalone");

/** Embeds MCP metadata and revocation without duplicating the surrounding Accesos page. */
export const mountOAuthListing = (
  configuration: Parameters<typeof mountManagement>[0]
): (() => void) => mountManagement(configuration, "Access");
