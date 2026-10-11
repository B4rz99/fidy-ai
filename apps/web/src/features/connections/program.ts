import { Clock, DateTime, Effect, type Layer, Option, Schema } from "effect";
import { Command, Runtime, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import {
  ConnectionAttemptReference,
  ConnectionContinuationReview,
  type WebAuthClient,
} from "@/transport/client";
import { card } from "@/ui/card";
import { buttonVariants } from "@/ui/button-variants";

const Model = Schema.Struct({
  review: Schema.Option(ConnectionContinuationReview),
  status: Schema.Literals(["Loading", "Ready", "Failed", "Preparing"]),
  uncertain: Schema.Boolean,
  expired: Schema.Boolean,
});
type Model = typeof Model.Type;
const Message = defineMessageUnion({
  LoadedReview: { review: ConnectionContinuationReview },
  FailedReview: {},
  ClickedRefresh: {},
  ClickedBegin: {},
  PreparedConnection: {},
  UncertainPreparation: {},
  ExpiredReview: {},
});
type Message = typeof Message.Type;
const expirationFormatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Bogota",
});
const busy = (model: Model): boolean => model.status === "Loading" || model.status === "Preparing";

const reviewCard = (
  model: Model,
  review: typeof ConnectionContinuationReview.Type,
  html: HtmlBuilder<Message>
): Html =>
  card({
    html,
    footer: [],
    className: "",
    title:
      review.phase === "prepared"
        ? "Conexión pendiente de autorización"
        : `Conectar ${review.institutionName}`,
    description:
      "La autorización con Bancolombia todavía no está disponible. No se ha autorizado acceso a tus cuentas.",
    content: [
      html.p(
        [],
        ["No compartas claves bancarias, documentos de identidad ni números de cuenta en Fidy."]
      ),
      html.p(
        [],
        [
          "Esta solicitud vence: ",
          html.time(
            [html.Datetime(DateTime.formatIso(review.expiresAt))],
            [expirationFormatter.format(DateTime.toDate(review.expiresAt))]
          ),
          ".",
        ]
      ),
      model.expired
        ? html.p([html.Role("alert")], ["La solicitud venció. Inicia una nueva conexión."])
        : null,
      review.phase === "ready"
        ? html.button(
            [
              html.Type("button"),
              html.Class(buttonVariants()),
              html.Disabled(
                busy(model) || model.uncertain || model.expired || model.status === "Failed"
              ),
              html.OnClick(Message.ClickedBegin()),
            ],
            [busy(model) ? "Continuando…" : "Continuar"]
          )
        : null,
    ],
  });

const reviewView = (
  model: Model,
  review: typeof ConnectionContinuationReview.Type,
  html: HtmlBuilder<Message>
): Html =>
  html.div(
    [html.Class("flex w-full max-w-md flex-col gap-3")],
    [
      model.uncertain && review.phase === "ready"
        ? html.p(
            [html.Role("alert")],
            [
              "No pudimos confirmar el resultado. Consulta el estado antes de continuar; no repitas esta solicitud.",
            ]
          )
        : null,
      model.status === "Failed"
        ? html.p(
            [html.Role("alert")],
            ["No pudimos actualizar el estado. La información mostrada puede estar desactualizada."]
          )
        : null,
      reviewCard(model, review, html),
      html.button(
        [
          html.Type("button"),
          html.Class(buttonVariants({ variant: "outline" })),
          html.Disabled(busy(model)),
          html.OnClick(Message.ClickedRefresh()),
        ],
        ["Consultar estado"]
      ),
    ]
  );

const reviewContent = (
  model: Model,
  html: HtmlBuilder<Message>,
  attempt: Option.Option<typeof ConnectionAttemptReference.Type>
): Html => {
  if (Option.isNone(attempt)) return html.p([html.Role("alert")], ["La solicitud no es válida."]);
  if (Option.isSome(model.review)) return reviewView(model, model.review.value, html);
  if (model.status === "Loading") return html.output([], ["Cargando solicitud…"]);
  return card({
    html,
    footer: [],
    className: "",
    title: "Solicitud no disponible",
    description:
      "Puede haber vencido o pertenecer a otra cuenta de Fidy. Inicia sesión con la cuenta que solicitó la conexión; si sigue sin estar disponible, inicia una nueva conexión.",
    content: [
      html.a(
        [
          html.Class(buttonVariants()),
          html.Href(`/auth/pair?connectionAttempt=${encodeURIComponent(attempt.value)}`),
        ],
        ["Iniciar sesión"]
      ),
    ],
  });
};
const view = (
  model: Model,
  html: HtmlBuilder<Message>,
  attempt: Option.Option<typeof ConnectionAttemptReference.Type>
): Html =>
  html.main(
    [html.Class("flex min-h-svh items-center justify-center bg-muted/40 px-4 py-12")],
    [reviewContent(model, html, attempt)]
  );

const makeCommands = (
  client: WebAuthClient,
  attempt: Option.Option<typeof ConnectionAttemptReference.Type>
): Readonly<{
  Load: () => Command.Command<Message>;
  Begin: () => Command.Command<Message>;
  Expire: (args: Readonly<{ expiresAt: number }>) => Command.Command<Message>;
}> => {
  const Load = Command.define("ReviewConnection", {
    messages: [Message.LoadedReview, Message.FailedReview],
    execute: Effect.gen(function* () {
      if (Option.isNone(attempt)) return Message.FailedReview();
      const api = yield* client;
      const review = yield* api.connectionBrowser.review({ query: { attempt: attempt.value } });
      return Message.LoadedReview({ review });
    }).pipe(Effect.catchCause(() => Effect.succeed(Message.FailedReview()))),
  });
  const Begin = Command.define("BeginConnection", {
    messages: [Message.PreparedConnection, Message.UncertainPreparation],
    execute: Effect.gen(function* () {
      if (Option.isNone(attempt)) return Message.UncertainPreparation();
      const api = yield* client;
      yield* api.connectionBrowser.begin({ payload: { attempt: attempt.value } });
      return Message.PreparedConnection();
    }).pipe(Effect.catchCause(() => Effect.succeed(Message.UncertainPreparation()))),
  });
  const Expire = Command.define("ExpireConnectionReview", {
    args: { expiresAt: Schema.Finite },
    messages: [Message.ExpiredReview],
    interrupt: true,
    execute: ({ expiresAt }) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => Effect.sleep(Math.max(0, expiresAt - now))),
        Effect.as(Message.ExpiredReview())
      ),
  });
  return { Load, Begin, Expire };
};

type ConnectionMount = Readonly<{
  container: HTMLElement;
  attempt: unknown;
  client: WebAuthClient;
  resources: Layer.Layer<never>;
}>;
/** Reviews a public attempt through the authenticated client; preparation requires an explicit click. */
export const mountConnectionContinuation = ({
  container,
  attempt: rawAttempt,
  client,
  resources,
}: ConnectionMount): (() => void) => {
  const attempt = Schema.decodeUnknownOption(ConnectionAttemptReference)(rawAttempt);
  const { Load, Begin, Expire } = makeCommands(client, attempt);
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container,
      resources,
      devTools: false,
      init: (): Update.Return<Model, Message> => ({
        model: { review: Option.none(), status: "Loading", uncertain: false, expired: false },
        commands: [Load()],
      }),
      update: (model, message): Update.Return<Model, Message> =>
        Message.match<Update.Return<Model, Message>>(message, {
          LoadedReview: ({ review }) => ({
            model: { ...model, review: Option.some(review), status: "Ready" },
            commands: [Expire({ expiresAt: review.expiresAt.epochMilliseconds })],
          }),
          FailedReview: () => ({ model: { ...model, status: "Failed" } }),
          ClickedRefresh: () =>
            busy(model)
              ? { model }
              : { model: { ...model, status: "Loading" }, commands: [Load()] },
          ClickedBegin: () =>
            busy(model) ||
            model.uncertain ||
            model.expired ||
            model.status === "Failed" ||
            Option.isNone(model.review) ||
            model.review.value.phase !== "ready"
              ? { model }
              : { model: { ...model, status: "Preparing" }, commands: [Begin()] },
          PreparedConnection: () => ({
            model: { ...model, status: "Loading" },
            commands: [Load()],
          }),
          UncertainPreparation: () => ({ model: { ...model, status: "Ready", uncertain: true } }),
          ExpiredReview: () => ({ model: { ...model, expired: true } }),
        }),
      view: (model, html) => view(model, html, attempt),
      crash: {
        view: (_, html) =>
          html.p(
            [html.Role("alert")],
            ["La solicitud no está disponible. Inicia una nueva conexión."]
          ),
      },
    })
  );
  return () => handle.dispose();
};
