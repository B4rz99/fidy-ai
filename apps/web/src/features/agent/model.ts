import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

const Entry = Schema.Struct({
  id: Schema.String,
  from: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
});
export const ConversationView = Schema.Struct({
  history: Schema.Array(Entry),
  reply: Schema.Option(Schema.Struct({ text: Schema.String, awaitingVisibility: Schema.Boolean })),
  status: Schema.String,
  hasDraft: Schema.Boolean,
  empty: Schema.Boolean,
  canSubmit: Schema.Boolean,
  canCheckProgress: Schema.Boolean,
  canRetryDelivery: Schema.Boolean,
});
export type ConversationView = typeof ConversationView.Type;
export const Action = Schema.Literals(["Submit", "Visible", "Progress", "Retry"]);
export type Action = typeof Action.Type;
export const Model = Schema.Struct({
  view: ConversationView,
  open: Schema.Boolean,
  hasDraft: Schema.Boolean,
});
export type Model = typeof Model.Type;
export const Message = defineMessageUnion({
  ChangedView: { view: ConversationView },
  ChangedDraft: { present: Schema.Boolean },
  ChangedOpen: { open: Schema.Boolean },
  RequestedWork: { action: Action },
  CompletedMount: {},
  CompletedWork: {},
});
export type Message = typeof Message.Type;
