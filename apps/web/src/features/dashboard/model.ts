import { Option, Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { DashboardCatalogEntry, DashboardEdit, DashboardView, WidgetId } from "@/transport/client";

export const Snapshot = Schema.Struct({
  view: Schema.Option(DashboardView),
  catalog: Schema.Array(DashboardCatalogEntry),
  status: Schema.Literals(["Loading", "Ready", "Failed"]),
  waiting: Schema.Boolean,
  stale: Schema.Boolean,
  boundaryFailure: Schema.Boolean,
  catalogWaiting: Schema.Boolean,
  catalogFailed: Schema.Boolean,
  phase: Schema.Literals(["reading", "initializing", "reading-initialized"]),
});
export type Snapshot = typeof Snapshot.Type;
export const initialSnapshot: Snapshot = {
  view: Option.none(),
  catalog: [],
  status: "Loading",
  waiting: true,
  stale: false,
  boundaryFailure: false,
  catalogWaiting: true,
  catalogFailed: false,
  phase: "reading",
};
export const Model = Schema.Struct({
  query: Snapshot,
  editing: Schema.Boolean,
  submitting: Schema.Boolean,
  error: Schema.Literals(["None", "Rejected", "Uncertain"]),
  renaming: Schema.Option(WidgetId),
  titleDraft: Schema.String,
});
export type Model = typeof Model.Type;
export const initialModel: Model = {
  query: initialSnapshot,
  editing: false,
  submitting: false,
  error: "None",
  renaming: Option.none(),
  titleDraft: "",
};
export const Message = defineMessageUnion({
  ChangedQuery: { query: Snapshot },
  ToggleEditing: {},
  RequestedEdit: { edit: DashboardEdit },
  SavedEdit: {},
  FailedEdit: { rejected: Schema.Boolean },
  InvalidEdit: {},
  Rename: { id: WidgetId, title: Schema.String },
  ChangedTitle: { title: Schema.String },
  SaveTitle: {},
  CancelTitle: {},
  Refresh: {},
  RefreshCatalog: {},
  Completed: {},
  Mounted: {},
});
export type Message = typeof Message.Type;
/** Financial reads must be current before another canonical edit can be issued. */
export const canEditDashboard = (model: Model): boolean =>
  model.editing &&
  !model.submitting &&
  model.error !== "Uncertain" &&
  model.query.status === "Ready" &&
  !model.query.stale &&
  !model.query.waiting;
