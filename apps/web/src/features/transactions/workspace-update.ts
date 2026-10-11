import { Option } from "effect";
import { type Command, type Update } from "foldkit";
import { maximumAtomicBatchCalls } from "@/transport/client";
import { transactionsEditable } from "./ledger-presentation";
import { Message, type Model, type QuerySnapshot, emptyFilters, initialModel } from "./model";

export type WorkspaceCommands = Readonly<{
  refresh: () => Command.Command<Message>;
  more: () => Command.Command<Message>;
  retryMore: () => Command.Command<Message>;
  category: (
    args: Readonly<{ id: string; categoryId: string; revision: number }>
  ) => Command.Command<Message>;
}>;
const queryContext = (query: QuerySnapshot): string =>
  Option.match(query.user, {
    onNone: () => "",
    onSome: (user) => `${user.id}|${user.timeZone}|${user.locale}`,
  });
const changedQuery = (model: Model, query: QuerySnapshot): Model => {
  if (queryContext(model.query) !== queryContext(query)) return { ...initialModel, query };
  const changed = model.query.generation !== query.generation;
  return changed
    ? { ...model, query, panel: "Summary", focus: Option.none(), selection: [], working: false }
    : { ...model, query };
};
const toggleSelection = (
  model: Model,
  id: Extract<Message, { _tag: "ToggledSelection" }>["id"]
): Model => {
  if (model.working || model.panel !== "Selecting") return model;
  if (model.selection.includes(id)) {
    return { ...model, selection: model.selection.filter((value) => value !== id) };
  }
  if (model.selection.length >= maximumAtomicBatchCalls) return model;
  return { ...model, selection: [...model.selection, id] };
};
const changeCategory = (
  configuration: Readonly<{
    model: Model;
    message: Extract<Message, { _tag: "ChangedCategory" }>;
    commands: WorkspaceCommands;
  }>
): Update.Return<Model, Message> => {
  const { model, message, commands } = configuration;
  const record = model.query.transactions.find((transaction) => transaction.id === message.id);
  const category = model.query.categories.find((item) => item.id === message.categoryId);
  if (
    !transactionsEditable(model) ||
    record === undefined ||
    category === undefined ||
    category.id === record.categoryId
  ) {
    return { model };
  }
  return {
    model: { ...model, working: true },
    commands: [
      commands.category({ id: record.id, categoryId: category.id, revision: record.revision }),
    ],
  };
};
type Result = Update.Return<Model, Message>;
type Handlers = { [Tag in Message["_tag"]]: (message: Extract<Message, { _tag: Tag }>) => Result };
const filterHandlers = (
  model: Model
): Pick<
  Handlers,
  "Filtered" | "ClearedFilters" | "ToggledFilters" | "Sorted" | "ToggledColumn"
> => ({
  Filtered: ({ field, value }: Extract<Message, { _tag: "Filtered" }>): Result => ({
    model: model.working
      ? model
      : {
          ...model,
          filters: { ...model.filters, [field]: value },
          selection: [],
          panel: "Summary",
        },
  }),
  ClearedFilters: (): Result => ({
    model: model.working
      ? model
      : { ...model, filters: emptyFilters, selection: [], panel: "Summary" },
  }),
  ToggledFilters: (): Result => ({ model: { ...model, filtersVisible: !model.filtersVisible } }),
  Sorted: ({ value }: Extract<Message, { _tag: "Sorted" }>): Result => ({
    model: { ...model, sort: value },
  }),
  ToggledColumn: ({ column }: Extract<Message, { _tag: "ToggledColumn" }>): Result => ({
    model: {
      ...model,
      categoryVisible: column === "category" ? !model.categoryVisible : model.categoryVisible,
      typeVisible: column === "type" ? !model.typeVisible : model.typeVisible,
    },
  }),
});
const panelHandlers = (
  model: Model
): Pick<
  Handlers,
  "Opened" | "Capture" | "Close" | "Edit" | "SelectMany" | "ToggledSelection" | "EditSelection"
> => ({
  Opened: ({ id }: Extract<Message, { _tag: "Opened" }>): Result => ({
    model: model.working
      ? model
      : {
          ...model,
          panel: transactionsEditable(model) ? "Correction" : "Detail",
          focus: Option.some(id),
        },
  }),
  Capture: (): Result => ({
    model: transactionsEditable(model)
      ? { ...model, panel: "Capture", focus: Option.none() }
      : model,
  }),
  Close: (): Result => ({
    model: model.working
      ? model
      : { ...model, panel: "Summary", focus: Option.none(), selection: [] },
  }),
  Edit: (): Result => ({
    model: transactionsEditable(model) ? { ...model, panel: "Correction" } : model,
  }),
  SelectMany: (): Result => ({
    model: transactionsEditable(model)
      ? {
          ...model,
          panel: model.panel === "Selecting" ? "Summary" : "Selecting",
          focus: Option.none(),
          selection: [],
        }
      : model,
  }),
  ToggledSelection: ({ id }: Extract<Message, { _tag: "ToggledSelection" }>): Result => ({
    model: toggleSelection(model, id),
  }),
  EditSelection: (): Result => ({
    model:
      transactionsEditable(model) && model.selection.length > 0
        ? { ...model, panel: "Bulk" }
        : model,
  }),
});
/** Keeps workspace interaction independent of query and mutation effects. */
export const makeWorkspaceUpdate =
  (
    commands: WorkspaceCommands
  ): ((model: Model, message: Message) => Update.Return<Model, Message>) =>
  (model, message) =>
    Message.match<Update.Return<Model, Message>>(message, {
      ChangedQuery: ({ query }) => ({ model: changedQuery(model, query) }),
      Refresh: () => ({
        model: model.working
          ? model
          : { ...model, feedback: "", panel: "Summary", focus: Option.none(), selection: [] },
        commands: model.working ? [] : [commands.refresh()],
      }),
      More: () => ({
        model,
        commands:
          transactionsEditable(model) && ["Summary", "Selecting"].includes(model.panel)
            ? [commands.more()]
            : [],
      }),
      RetryMore: () => ({
        model,
        commands:
          transactionsEditable(model) && ["Summary", "Selecting"].includes(model.panel)
            ? [commands.retryMore()]
            : [],
      }),
      ...filterHandlers(model),
      ...panelHandlers(model),
      ChangedWorking: ({ working }) => ({ model: { ...model, working } }),
      ChangedCategory: () =>
        message._tag === "ChangedCategory"
          ? changeCategory({ model, message, commands })
          : { model },
      FailedCategory: () => ({
        model: {
          ...model,
          working: false,
          feedback:
            "No pudimos confirmar el cambio. Actualiza el historial antes de volver a editar.",
        },
      }),
      Saved: ({ notice, title }) => ({
        model: {
          ...model,
          panel: "Summary",
          focus: Option.none(),
          selection: [],
          working: false,
          feedback: "",
          notice,
          noticeTitle: title,
        },
        commands: [commands.refresh()],
      }),
      Completed: () => ({ model }),
      Mounted: () => ({ model }),
    });
