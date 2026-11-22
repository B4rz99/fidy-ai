import type { RecurringDocument, RecurringSchedule } from "../../src/core/recurring-plans/contract";
import { Data, type Option } from "effect";

export class RecurringPlanningUnavailable extends Data.TaggedError("RecurringPlanningUnavailable")<{
  readonly cause: Option.Option<unknown>;
}> {}

export type RecurringReadProjection = Readonly<{
  months: ReadonlyArray<string>;
  schedule: RecurringSchedule;
  editing: RecurringDocument;
}>;
