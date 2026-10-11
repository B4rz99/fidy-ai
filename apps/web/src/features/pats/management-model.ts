import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { ActivePATList, TokenShortId } from "@/transport/client";

export const Selection = Schema.Union([TokenShortId, Schema.Literal("all")]);
export type Selection = typeof Selection.Type;
export const ManagementModel = Schema.Struct({
  result: Schema.Option(ActivePATList),
  status: Schema.Literals(["Loading", "Ready", "Failed", "Revoking"]),
  selection: Schema.Option(Selection),
  notice: Schema.String,
  uncertain: Schema.Boolean,
});
export type ManagementModel = typeof ManagementModel.Type;
export const ManagementMessage = defineMessageUnion({
  Loaded: { result: ActivePATList },
  Failed: {},
  Refresh: {},
  Select: { selection: Selection },
  Cancel: {},
  Confirm: {},
  Revoked: { notice: Schema.String },
  RevokeFailed: {},
  Mounted: {},
});
export type ManagementMessage = typeof ManagementMessage.Type;
