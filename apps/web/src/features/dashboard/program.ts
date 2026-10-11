import {
  Cause,
  Effect,
  type Layer,
  Option,
  Predicate,
  Queue,
  Result,
  Schema,
  type Scope,
  Stream,
} from "effect";
import type { AtomRegistry } from "effect/reactivity";
import { Command, Mount, Runtime, Subscription, type Update } from "foldkit";
import { DashboardEdit, type FidyClient, WidgetId } from "@/transport/client";
import { DashboardDragSourceData, DashboardDropTargetData } from "./drag-data";
import { type DashboardGesture, compileDashboardGesture } from "./editor-model";
import { type DashboardMounts, dashboardView } from "./foldkit-view";
import { Message, Model, canEditDashboard, initialModel } from "./model";
import { makeDashboardDragOwner } from "./native-drag";
import { bindDashboardResize } from "./native-resize";
import type { DashboardLayout, DashboardWidget } from "./presentation";
import { makeDashboardQueryOwner } from "./query-owner";

type Configuration = Readonly<{
  container: HTMLElement;
  client: FidyClient;
  registry: AtomRegistry.AtomRegistry;
  resources: Layer.Layer<never>;
}>;
const findWidget = (layout: DashboardLayout, id: string): Option.Option<DashboardWidget> => {
  if (layout.kind !== "leaf") {
    return Option.fromUndefinedOr(
      layout.children.flatMap(({ node }) => Option.toArray(findWidget(node, id)))[0]
    );
  }
  return layout.widget.widget.id === id ? Option.some(layout.widget.widget) : Option.none();
};
const applyEdit = Effect.fn("dashboard.applyCanonicalEdit")(function* (
  client: FidyClient,
  edit: DashboardEdit
) {
  const api = yield* client;
  switch (edit.op) {
    case "set-title":
      return yield* api.dashboard.applyDashboardEdit({ payload: edit });
    case "add-widget":
      return yield* api.dashboard.applyDashboardEdit({ payload: edit });
    case "remove-widget":
      return yield* api.dashboard.applyDashboardEdit({ payload: edit });
    case "move-widget":
      return yield* api.dashboard.applyDashboardEdit({ payload: edit });
    case "swap-widgets":
      return yield* api.dashboard.applyDashboardEdit({ payload: edit });
    case "resize-region":
      return yield* api.dashboard.applyDashboardEdit({ payload: edit });
    case "update-widget":
      return yield* api.dashboard.applyDashboardEdit({ payload: edit });
  }
});
const rejected = (cause: Cause.Cause<unknown>): boolean =>
  !Cause.hasDies(cause) &&
  !Cause.hasInterrupts(cause) &&
  Option.exists(
    Cause.findErrorOption(cause),
    (error) =>
      Predicate.isTagged(error, "NotFound") || Predicate.isTagged(error, "ValidationFailed")
  );
type Commands = Readonly<{
  edit: (args: Readonly<{ edit: DashboardEdit }>) => Command.Command<Message>;
  refresh: () => Command.Command<Message>;
  refreshCatalog: () => Command.Command<Message>;
}>;
const requestEdit = ({
  model,
  edit,
  commands,
}: Readonly<{ model: Model; edit: DashboardEdit; commands: Commands }>): Update.Return<
  Model,
  Message
> =>
  canEditDashboard(model)
    ? {
        model: {
          ...model,
          submitting: true,
          error: "None",
          renaming: Option.none(),
          titleDraft: "",
        },
        commands: [commands.edit({ edit })],
      }
    : { model };
const saveTitle = (model: Model, commands: Commands): Update.Return<Model, Message> => {
  if (Option.isNone(model.renaming) || Option.isNone(model.query.view)) return { model };
  const widget = findWidget(model.query.view.value.layout, model.renaming.value);
  if (Option.isNone(widget)) return { model };
  const edit = compileDashboardGesture({
    kind: "retitle-widget",
    widget: widget.value,
    title: model.titleDraft.trim(),
  });
  return Result.isFailure(edit)
    ? { model: { ...model, error: "Rejected" } }
    : requestEdit({ model, edit: edit.success, commands });
};
type Return = Update.Return<Model, Message>;
type Handlers = { [Tag in Message["_tag"]]: (message: Extract<Message, { _tag: Tag }>) => Return };
const editorHandlers = (
  model: Model,
  commands: Commands
): Pick<
  Handlers,
  "ToggleEditing" | "RequestedEdit" | "Rename" | "ChangedTitle" | "SaveTitle" | "CancelTitle"
> => ({
  ToggleEditing: (): Return => ({
    model: model.submitting
      ? model
      : { ...model, editing: !model.editing, renaming: Option.none(), titleDraft: "" },
  }),
  RequestedEdit: ({ edit }): Return => requestEdit({ model, edit, commands }),
  Rename: ({ id, title }): Return => ({
    model: canEditDashboard(model)
      ? { ...model, renaming: Option.some(id), titleDraft: title }
      : model,
  }),
  ChangedTitle: ({ title }): Return => ({
    model: canEditDashboard(model) ? { ...model, titleDraft: title } : model,
  }),
  SaveTitle: (): Return => saveTitle(model, commands),
  CancelTitle: (): Return => ({ model: { ...model, renaming: Option.none(), titleDraft: "" } }),
});
const queryHandlers = (
  model: Model,
  commands: Commands
): Pick<
  Handlers,
  | "ChangedQuery"
  | "SavedEdit"
  | "FailedEdit"
  | "InvalidEdit"
  | "Refresh"
  | "RefreshCatalog"
  | "Completed"
  | "Mounted"
> => ({
  ChangedQuery: ({ query }): Return => ({ model: { ...model, query } }),
  SavedEdit: (): Return => ({
    model: { ...model, submitting: false, query: { ...model.query, waiting: true } },
    commands: [commands.refresh()],
  }),
  FailedEdit: ({ rejected }): Return => ({
    model: { ...model, submitting: false, error: rejected ? "Rejected" : "Uncertain" },
  }),
  InvalidEdit: (): Return => ({ model: { ...model, error: "Rejected" } }),
  Refresh: (): Return => ({
    model: model.submitting
      ? model
      : {
          ...model,
          query: { ...model.query, waiting: true },
          error: "None",
          renaming: Option.none(),
          titleDraft: "",
        },
    commands: model.submitting ? [] : [commands.refresh()],
  }),
  RefreshCatalog: (): Return => ({ model, commands: [commands.refreshCatalog()] }),
  Completed: (): Return => ({ model }),
  Mounted: (): Return => ({ model }),
});
const makeUpdate =
  (commands: Commands): ((model: Model, message: Message) => Return) =>
  (model, message) =>
    Message.match<Return>(message, {
      ...editorHandlers(model, commands),
      ...queryHandlers(model, commands),
    });
const makeCommands = (
  client: FidyClient,
  owner: ReturnType<typeof makeDashboardQueryOwner>
): Commands => {
  const action = (name: string, run: () => void): (() => Command.Command<Message>) =>
    Command.define(name, {
      messages: [Message.Completed],
      execute: Effect.sync(() => {
        run();
        return Message.Completed();
      }),
    });
  return {
    refresh: action("RefreshDashboard", owner.refresh),
    refreshCatalog: action("RefreshDashboardCatalog", owner.refreshCatalog),
    edit: Command.define("ApplyDashboardEdit", {
      args: { edit: DashboardEdit },
      messages: [Message.SavedEdit, Message.FailedEdit],
      execute: ({ edit }) =>
        applyEdit(client, edit).pipe(
          Effect.as(Message.SavedEdit()),
          Effect.catchCause((cause) =>
            Effect.succeed(Message.FailedEdit({ rejected: rejected(cause) }))
          )
        ),
    }),
  };
};
type Interaction = Readonly<{
  drag: ReturnType<typeof makeDashboardDragOwner>;
  enabled: () => boolean;
  gesture: (gesture: DashboardGesture) => void;
}>;
const scopedMount = (
  acquire: () => () => void
): Effect.Effect<Extract<Message, { _tag: "Mounted" }>, never, Scope.Scope> =>
  Effect.acquireRelease(Effect.sync(acquire), (release) => Effect.sync(release)).pipe(
    Effect.as(Message.Mounted())
  );
const makeMounts = ({ drag, enabled, gesture }: Interaction): DashboardMounts => ({
  source: Mount.define("DashboardDragSource", {
    args: { data: DashboardDragSourceData },
    messages: [Message.Mounted],
    execute: ({ data, element }) =>
      element instanceof HTMLElement
        ? scopedMount(() => drag.source(element, data))
        : Effect.succeed(Message.Mounted()),
  }),
  target: Mount.define("DashboardDropTarget", {
    args: { data: DashboardDropTargetData, depth: Schema.Finite },
    messages: [Message.Mounted],
    execute: ({ data, depth, element }) =>
      element instanceof HTMLElement
        ? scopedMount(() => drag.target({ element, data, depth }))
        : Effect.succeed(Message.Mounted()),
  }),
  resize: Mount.define("DashboardResize", {
    args: {
      axis: Schema.Literals(["row", "column"]),
      weight: Schema.Finite,
      adjacentWeight: Schema.Finite,
      widgetIds: Schema.Array(WidgetId),
    },
    messages: [Message.Mounted],
    execute: ({ element, widgetIds, ...args }) =>
      !(element instanceof HTMLElement)
        ? Effect.succeed(Message.Mounted())
        : scopedMount(() =>
            bindDashboardResize({
              ...args,
              element,
              enabled,
              resize: (weight) => {
                const first = widgetIds[0];
                if (first !== undefined) {
                  gesture({
                    kind: "resize-region",
                    widgetIds: [first, ...widgetIds.slice(1)],
                    weight,
                  });
                }
              },
            })
          ),
  }),
});
/** Mounts native Dashboard reads, canonical edits, and scoped DOM interactions. */
export const mountDashboard = (configuration: Configuration): (() => void) => {
  const events = Effect.runSync(Queue.unbounded<Message>());
  let active = true;
  let editable = false;
  const dispatch = (message: Message): void => {
    if (active) Queue.offerUnsafe(events, message);
  };
  const gesture = (value: DashboardGesture): void => {
    if (!editable) return;
    const result = compileDashboardGesture(value);
    dispatch(
      Result.isSuccess(result)
        ? Message.RequestedEdit({ edit: result.success })
        : Message.InvalidEdit()
    );
  };
  const enabled = (): boolean => active && editable;
  const drag = makeDashboardDragOwner({ enabled, gesture });
  const owner = makeDashboardQueryOwner({
    ...configuration,
    changed: (query) => dispatch(Message.ChangedQuery({ query })),
  });
  const mounts = makeMounts({ drag, enabled, gesture });
  const dispose = (): void => {
    active = false;
    editable = false;
    owner.dispose();
    drag.dispose();
  };
  const handle = Runtime.embed(
    Runtime.makeElement({
      Model,
      container: configuration.container,
      resources: configuration.resources,
      devTools: false,
      init: (): Update.Return<Model, Message> => ({ model: initialModel }),
      update: makeUpdate(makeCommands(configuration.client, owner)),
      view: (model, html) => {
        editable = canEditDashboard(model);
        return dashboardView({ model, html, mounts, targetLabel: Option.none() });
      },
      subscriptions: Subscription.make<Model, Message>()(() => ({
        events: Subscription.persistent(Stream.fromQueue(events)),
      })),
      crash: {
        report: dispose,
        view: (_, html) =>
          html.p(
            [html.Role("alert")],
            ["Recarga y consulta el tablero antes de repetir un cambio."]
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
