import { Data } from "effect";
import { type InsightEventId, type InsightLifecycleState } from "./model";

/** The asked-for occurrence is absent from this User's InsightEvent stream. */
export class InsightNotFound extends Data.TaggedError("InsightNotFound")<{
  readonly insightEventId: InsightEventId;
}> {}

/** A requested lifecycle movement would move backward or repeat the current state. */
export class InvalidInsightTransition extends Data.TaggedError("InvalidInsightTransition")<{
  readonly current: InsightLifecycleState;
  readonly target: InsightLifecycleState;
  readonly allowedTargets: ReadonlyArray<InsightLifecycleState>;
}> {}

/** Every caller-actionable failure raised by the insights core. */
export type InsightFailure = InsightNotFound | InvalidInsightTransition;
