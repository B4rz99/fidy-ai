import { Schema } from "effect";
import type { EventMetricSignal } from "../contract";

export const WorkflowFailureCounts = Schema.Struct({
  recentCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  fiveMinuteCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const minuteMs = 60_000;
const recentWindowMinutes = 15;
const freshWindowMinutes = 5;
export const recentWindowMs = recentWindowMinutes * minuteMs;
export const fiveMinuteWindowMs = freshWindowMinutes * minuteMs;
export const bucketRetentionMs = 86_400_000;
export const maximumSweepRows = 128;

export const unavailableMetrics = (): ReadonlyArray<EventMetricSignal> => [
  { component: "workflow-execution", operation: "workflowFailures", state: "unavailable" },
];
