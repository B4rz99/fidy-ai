import { Option, Result } from "effect";
import type { Command, Update } from "foldkit";
import type { DashboardEdit } from "@/transport/client";
import { compileDashboardGesture } from "./editor-model";
import { Message, type Model, canEditDashboard } from "./model";
import type { DashboardLayout, DashboardWidget } from "./presentation";

const findWidget = (layout: DashboardLayout, id: string): Option.Option<DashboardWidget> => {
  if (layout.kind !== "leaf") {
    return Option.fromUndefinedOr(
      layout.children.flatMap(({ node }) => Option.toArray(findWidget(node, id)))[0]
    );
  }
  return layout.widget.widget.id === id ? Option.some(layout.widget.widget) : Option.none();
};
export type DashboardCommands = Readonly<{
  edit: (args: Readonly<{ edit: DashboardEdit }>) => Command.Command<Message>;
  refresh: () => Command.Command<Message>;
  refreshCatalog: () => Command.Command<Message>;
}>;
const requestEdit = ({
  model,
  edit,
  commands,
}: Readonly<{ model: Model; edit: DashboardEdit; commands: DashboardCommands }>): Update.Return<
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
const saveTitle = (model: Model, commands: DashboardCommands): Update.Return<Model, Message> => {
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
  commands: DashboardCommands
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
  commands: DashboardCommands
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
export const makeDashboardUpdate =
  (commands: DashboardCommands): ((model: Model, message: Message) => Return) =>
  (model, message) =>
    Message.match<Return>(message, {
      ...editorHandlers(model, commands),
      ...queryHandlers(model, commands),
    });
