import type { RecurringDocument, RecurringSchedule } from "../../src/core/recurring-plans/contract";
import { Data } from "effect";

export class RecurringPlanningUnavailable extends Data.TaggedError(
  "RecurringPlanningUnavailable"
) {}

export type RecurringReadProjection = Readonly<{
  months: ReadonlyArray<string>;
  schedule: RecurringSchedule;
  editing: RecurringDocument;
}>;
