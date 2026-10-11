import { Option, Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Category, Transaction, TransactionId, User } from "@/transport/client";

export const QuerySnapshot = Schema.Struct({
  user: Schema.Option(User),
  transactions: Schema.Array(Transaction),
  categories: Schema.Array(Category),
  status: Schema.Literals(["Loading", "Ready", "Failed"]),
  boundaryFailure: Schema.Boolean,
  stale: Schema.Boolean,
  waiting: Schema.Boolean,
  continuation: Schema.Literals(["complete", "available", "loading", "failure"]),
  generation: Schema.Int,
  monthLabel: Schema.String,
  timeZone: Schema.String,
});
export type QuerySnapshot = typeof QuerySnapshot.Type;
export const initialQuery: QuerySnapshot = {
  user: Option.none(),
  transactions: [],
  categories: [],
  status: "Loading",
  boundaryFailure: false,
  stale: false,
  waiting: true,
  continuation: "complete",
  generation: 0,
  monthLabel: "",
  timeZone: "",
};
export const Filters = Schema.Struct({
  search: Schema.String,
  direction: Schema.String,
  categoryId: Schema.String,
  date: Schema.String,
});
export type Filters = typeof Filters.Type;
export const emptyFilters: Filters = { search: "", direction: "all", categoryId: "all", date: "" };
export const Model = Schema.Struct({
  query: QuerySnapshot,
  filters: Filters,
  sort: Schema.String,
  filtersVisible: Schema.Boolean,
  categoryVisible: Schema.Boolean,
  typeVisible: Schema.Boolean,
  panel: Schema.Literals(["Summary", "Detail", "Capture", "Selecting", "Bulk", "Correction"]),
  focus: Schema.Option(TransactionId),
  selection: Schema.Array(TransactionId),
  working: Schema.Boolean,
  feedback: Schema.String,
  notice: Schema.String,
  noticeTitle: Schema.String,
});
export type Model = typeof Model.Type;
export const initialModel: Model = {
  query: initialQuery,
  filters: emptyFilters,
  sort: "default",
  filtersVisible: false,
  categoryVisible: true,
  typeVisible: true,
  panel: "Summary",
  focus: Option.none(),
  selection: [],
  working: false,
  feedback: "",
  notice: "",
  noticeTitle: "",
};
export const Message = defineMessageUnion({
  ChangedQuery: { query: QuerySnapshot },
  Refresh: {},
  More: {},
  RetryMore: {},
  Filtered: {
    field: Schema.Literals(["search", "direction", "categoryId", "date"]),
    value: Schema.String,
  },
  ClearedFilters: {},
  ToggledFilters: {},
  ChangedCategory: { id: TransactionId, categoryId: Schema.String },
  FailedCategory: {},
  Sorted: { value: Schema.String },
  ToggledColumn: { column: Schema.Literals(["category", "type"]) },
  Opened: { id: TransactionId },
  Capture: {},
  Close: {},
  Edit: {},
  SelectMany: {},
  ToggledSelection: { id: TransactionId },
  EditSelection: {},
  ChangedWorking: { working: Schema.Boolean },
  Saved: { notice: Schema.String, title: Schema.String },
  Completed: {},
  Mounted: {},
});
export type Message = typeof Message.Type;
