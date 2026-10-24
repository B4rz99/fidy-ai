import { Schema } from "effect";

export const periodMs = 300_000;
export const staleMs = 600_000;
export const WorkflowStatus = Schema.Struct({
  status: Schema.Literals([
    "queued",
    "running",
    "waiting",
    "complete",
    "paused",
    "errored",
    "terminated",
    "unknown",
    "waitingForPause",
  ]),
});
