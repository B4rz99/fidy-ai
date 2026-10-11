import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

export const EditorDraft = Schema.Struct({
  categoryId: Schema.String,
  direction: Schema.String,
  counterparty: Schema.String,
  notes: Schema.String,
  amount: Schema.String,
  date: Schema.String,
});
export type EditorDraft = typeof EditorDraft.Type;
export const EditorStatus = Schema.Literals(["idle", "saving", "invalid", "rejected", "uncertain"]);
export type EditorStatus = typeof EditorStatus.Type;
export const EditorModel = Schema.Struct({ draft: EditorDraft, status: EditorStatus });
export type EditorModel = typeof EditorModel.Type;
export const EditorMessage = defineMessageUnion({
  Changed: {
    field: Schema.Literals(["categoryId", "direction", "counterparty", "notes", "amount", "date"]),
    value: Schema.String,
  },
  Submit: {},
  Saved: {},
  Invalid: {},
  Rejected: {},
  Uncertain: {},
  Cancel: {},
  Refresh: {},
  Completed: {},
});
export type EditorMessage = typeof EditorMessage.Type;
