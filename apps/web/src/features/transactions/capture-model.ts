import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { CaptureDraft, CaptureStatus } from "./capture-draft";

export const CaptureModel = Schema.Struct({ draft: CaptureDraft, status: CaptureStatus });
export type CaptureModel = typeof CaptureModel.Type;
export const CaptureMessage = defineMessageUnion({
  Changed: {
    field: Schema.Literals(["amount", "counterparty", "occurredOn", "direction"]),
    value: Schema.String,
  },
  Submit: {},
  Saved: {},
  Failed: {},
  Uncertain: {},
  CheckHistory: {},
  Notified: {},
});
export type CaptureMessage = typeof CaptureMessage.Type;
