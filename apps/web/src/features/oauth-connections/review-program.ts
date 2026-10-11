import { Effect, type Layer, Option, Schema } from "effect";
import { Command, Runtime, type Update } from "foldkit";
import {
  OAuthRequestId,
  OAuthReviewChoice,
  type WebAuthClient,
  defaultPATLifetimeDays,
} from "@/transport/client";
import { Message, Model, editable, selectedChoice } from "./review-model";
import { reviewView } from "./review-view";

type Commands = Readonly<{
  Load: () => Command.Command<Message>;
  Cancel: () => Command.Command<Message>;
  Connect: (args: Readonly<{ choice: OAuthReviewChoice }>) => Command.Command<Message>;
}>;
const makeCommands = (
  client: WebAuthClient,
  requestId: Option.Option<string>,
  redirect: (callback: string) => void
): Commands => ({
  Load: Command.define("ReviewOAuthRequest", {
    messages: [Message.Loaded, Message.Failed],
    execute: Effect.gen(function* () {
      if (Option.isNone(requestId)) return Message.Failed();
      const api = yield* client;
      const review = yield* api.oauthReview.review({ query: { requestId: requestId.value } });
      return Message.Loaded({ review });
    }).pipe(Effect.catchCause(() => Effect.succeed(Message.Failed()))),
  }),
  Cancel: Command.define("CancelOAuthRequest", {
    messages: [Message.Cancelled, Message.CancelFailed],
    execute: Effect.gen(function* () {
      if (Option.isNone(requestId)) return Message.CancelFailed();
      const api = yield* client;
      yield* api.oauthReview.cancel({ payload: { requestId: requestId.value } });
      return Message.Cancelled();
    }).pipe(Effect.catchCause(() => Effect.succeed(Message.CancelFailed()))),
  }),
  Connect: Command.define("ConnectOAuthRequest", {
    args: { choice: OAuthReviewChoice },
    messages: [Message.Redirected, Message.Uncertain],
    execute: ({ choice }) =>
      Effect.gen(function* () {
        const api = yield* client;
        const connected = yield* api.oauthReview.connect({ payload: choice });
        yield* Effect.sync(() => redirect(connected.callback));
        return Message.Redirected();
      }).pipe(Effect.catchCause(() => Effect.succeed(Message.Uncertain()))),
  }),
});
const makeUpdate =
  ({
    Cancel,
    Connect,
  }: Commands): ((model: Model, message: Message) => Update.Return<Model, Message>) =>
  (model, message) =>
    Message.match<Update.Return<Model, Message>>(message, {
      Loaded: ({ review }) => ({
        model: { ...model, review: Option.some(review), scopes: review.scopes, status: "Ready" },
      }),
      Failed: () => ({ model: { ...model, status: "Unavailable" } }),
      ToggledScope: ({ scope }) =>
        editable(model) && Option.isSome(model.review) && model.review.value.scopes.includes(scope)
          ? {
              model: {
                ...model,
                scopes: model.scopes.includes(scope)
                  ? model.scopes.filter((current) => current !== scope)
                  : [...model.scopes, scope],
              },
            }
          : { model },
      SelectedDays: ({ days }) => (editable(model) ? { model: { ...model, days } } : { model }),
      ClickedConnect: () =>
        !editable(model)
          ? { model }
          : Option.match(selectedChoice(model), {
              onNone: () => ({ model }),
              onSome: (choice) => ({
                model: { ...model, status: "Connecting" },
                commands: [Connect({ choice })],
              }),
            }),
      ClickedCancel: () =>
        editable(model)
          ? { model: { ...model, status: "Cancelling" }, commands: [Cancel()] }
          : { model },
      Cancelled: () => ({ model: { ...model, status: "Cancelled" } }),
      CancelFailed: () => ({ model: { ...model, status: "CancelFailed" } }),
      Uncertain: () => ({ model: { ...model, status: "Uncertain" } }),
      Redirected: () => ({ model }),
    });
/** Callback credentials travel directly from the command to navigation and never enter messages. */
export const mountOAuthReview = ({
  container,
  client,
  resources,
  requestId: rawRequestId,
  redirect,
}: Readonly<{
  container: HTMLElement;
  client: WebAuthClient;
  resources: Layer.Layer<never>;
  requestId: unknown;
  redirect: (callback: string) => void;
}>): (() => void) => {
  let active = true;
  const requestId = Schema.decodeUnknownOption(OAuthRequestId)(rawRequestId);
  const commands = makeCommands(client, requestId, (callback) => {
    if (active) redirect(callback);
  });
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      resources,
      devTools: false,
      init: (): Update.Return<Model, Message> => ({
        model: {
          review: Option.none(),
          scopes: [],
          days: defaultPATLifetimeDays,
          status: "Loading",
        },
        commands: [commands.Load()],
      }),
      update: makeUpdate(commands),
      view: (model, html) => reviewView({ model, html, requestId }),
      crash: {
        view: (_, html) =>
          html.p(
            [html.Role("alert")],
            ["No pudimos confirmar la autorización. Inicia una nueva conexión."]
          ),
      },
    })
  );
  return () => {
    active = false;
    handle.dispose();
  };
};
