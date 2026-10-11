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
import { makeDashboardQueryOwner } from "./query-owner";
import { type DashboardCommands, makeDashboardUpdate } from "./workspace-update";

type Configuration = Readonly<{
  container: HTMLElement;
  client: FidyClient;
  registry: AtomRegistry.AtomRegistry;
  resources: Layer.Layer<never>;
}>;
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
const makeCommands = (
  client: FidyClient,
  owner: ReturnType<typeof makeDashboardQueryOwner>
): DashboardCommands => {
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
      update: makeDashboardUpdate(makeCommands(configuration.client, owner)),
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
