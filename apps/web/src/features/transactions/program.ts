import { Array, Effect, type Layer, Option, Queue, Schema, Stream } from "effect";
import { type AtomRegistry } from "effect/reactivity";
import { Command, Mount, Runtime, Subscription, type Update } from "foldkit";
import { mountElementProgram } from "@/browser/element-program";
import { bindResponsivePanel } from "@/browser/responsive-panel";
import { type FidyClient, Transaction, TransactionId } from "@/transport/client";
import { mountTransactionCapture } from "./capture-program";
import { mountTransactionEditor } from "./editor-program";
import { transactionsView } from "./foldkit-view";
import { Message, Model, initialModel } from "./model";
import { type QueryOwner, makeTransactionQueryOwner } from "./query-owner";
import { formatOccurrence } from "./presentation";
import { type WorkspaceCommands, makeWorkspaceUpdate } from "./workspace-update";

type Configuration = Readonly<{
  container: HTMLElement;
  client: FidyClient;
  resources: Layer.Layer<never>;
  registry: AtomRegistry.AtomRegistry;
}>;
const decodeCategoryId = Schema.decodeOption(Transaction.fields.categoryId);
const decodeTransactionId = Schema.decodeUnknownOption(TransactionId);
const makeCommands = (client: FidyClient, owner: QueryOwner): WorkspaceCommands => {
  const action = (name: string, execute: () => void): (() => Command.Command<Message>) =>
    Command.define(name, {
      messages: [Message.Completed],
      execute: Effect.sync(() => {
        execute();
        return Message.Completed();
      }),
    });
  return {
    refresh: action("RefreshTransactions", owner.refresh),
    more: action("MoreTransactions", owner.more),
    retryMore: action("RetryMoreTransactions", owner.retryMore),
    category: Command.define("ChangeTransactionCategory", {
      args: { id: Schema.String, categoryId: Schema.String, revision: Schema.Int },
      messages: [Message.Saved, Message.FailedCategory],
      execute: ({ id, categoryId, revision }) =>
        Effect.gen(function* () {
          const transactionId = decodeTransactionId(id);
          if (Option.isNone(transactionId)) return Message.FailedCategory();
          const api = yield* client;
          const category = decodeCategoryId(categoryId);
          if (Option.isNone(category)) return Message.FailedCategory();
          yield* api.transactions.updateTransaction({
            params: { id: transactionId.value },
            payload: { expectedRevision: revision, changes: { categoryId: category.value } },
          });
          return Message.Saved({ notice: "", title: "Categoría guardada" });
        }).pipe(Effect.catchCause(() => Effect.succeed(Message.FailedCategory()))),
    }),
  };
};
const mountChild = (
  configuration: Readonly<{
    model: Model;
    container: HTMLElement;
    application: Configuration;
    dispatch: (message: Message) => void;
  }>
): (() => void) => {
  const { model, container, application, dispatch } = configuration;
  const common = {
    container,
    client: application.client,
    resources: application.resources,
    timeZone: model.query.timeZone,
  };
  if (model.panel === "Capture") {
    return mountTransactionCapture({
      ...common,
      onCreated: (transaction) =>
        dispatch(
          Message.Saved({
            title: "Transacción registrada",
            notice: `${Option.getOrElse(transaction.counterparty, () => "Contraparte no identificada")} · ${formatOccurrence({ locale: Option.match(model.query.user, { onNone: () => "es-CO", onSome: (user) => user.locale }), timeZone: model.query.timeZone, occurredAt: transaction.occurredAt })}`,
          })
        ),
      onStatus: (status) => dispatch(Message.ChangedWorking({ working: status === "saving" })),
      onCheckHistory: () => dispatch(Message.Refresh()),
    });
  }
  const records = model.query.transactions.filter((record) =>
    model.panel === "Bulk"
      ? model.selection.includes(record.id)
      : Option.contains(model.focus, record.id)
  );
  if (!Array.isReadonlyArrayNonEmpty(records)) return (): void => {};
  return mountTransactionEditor({
    ...common,
    categories: model.query.categories,
    mode:
      model.panel === "Bulk"
        ? { _tag: "Bulk", transactions: records }
        : { _tag: "Single", transaction: records[0] },
    onSaved: () => dispatch(Message.Saved({ notice: "", title: "Cambios guardados" })),
    onCancel: () => dispatch(Message.Close()),
    onRefresh: () => dispatch(Message.Refresh()),
    onStatus: (status) => dispatch(Message.ChangedWorking({ working: status === "saving" })),
  });
};
const makeMounts = (
  application: Configuration,
  dispatch: (message: Message) => void
): Readonly<{
  child: (args: Readonly<{ model: Model }>) => Mount.MountAction<Message>;
  responsive: (args: Readonly<{ model: Model }>) => Mount.MountAction<Message>;
}> => ({
  child: Mount.define("TransactionInteraction", {
    args: { model: Model },
    messages: [Message.Mounted],
    execute: ({ model, element }) =>
      !(element instanceof HTMLElement)
        ? Effect.succeed(Message.Mounted())
        : Effect.acquireRelease(
            Effect.sync(() =>
              mountElementProgram({
                host: element,
                mount: (container) => mountChild({ model, container, application, dispatch }),
              })
            ),
            (release) => Effect.sync(release)
          ).pipe(Effect.as(Message.Mounted())),
  }),
  responsive: Mount.define("ResponsiveTransactionPanel", {
    args: { model: Model },
    messages: [Message.Mounted],
    execute: ({ element }) =>
      !(element instanceof HTMLElement)
        ? Effect.succeed(Message.Mounted())
        : Effect.acquireRelease(
            Effect.sync(() => bindResponsivePanel(element)),
            (release) => Effect.sync(release)
          ).pipe(Effect.as(Message.Mounted())),
  }),
});
/** Owns native workspace interaction for the authentication lifetime's canonical query registry. */
export const mountTransactions = (configuration: Configuration): (() => void) => {
  const events = Effect.runSync(Queue.unbounded<Message>());
  let active = true;
  const dispatch = (message: Message): void => {
    if (active) Queue.offerUnsafe(events, message);
  };
  const owner = makeTransactionQueryOwner({
    ...configuration,
    changed: (query) => dispatch(Message.ChangedQuery({ query })),
  });
  const commands = makeCommands(configuration.client, owner);
  const mounts = makeMounts(configuration, dispatch);
  const dispose = (): void => {
    active = false;
    owner.dispose();
  };
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container: configuration.container,
      resources: configuration.resources,
      devTools: false,
      init: (): Update.Return<Model, Message> => ({ model: initialModel }),
      update: makeWorkspaceUpdate(commands),
      view: (model, html) =>
        transactionsView({ model, html, mount: mounts.child, responsive: mounts.responsive }),
      subscriptions: Subscription.make<Model, Message>()(() => ({
        queries: Subscription.persistent(Stream.fromQueue(events)),
      })),
      crash: {
        report: dispose,
        view: (_, html) =>
          html.p(
            [html.Role("alert")],
            ["Recarga la página y consulta el historial antes de repetir un cambio."]
          ),
      },
    })
  );
  return (): void => {
    dispose();
    handle.dispose();
    Effect.runSync(Queue.shutdown(events));
  };
};
