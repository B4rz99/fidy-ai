import type { CanonicalPreparationWork } from "../canonical-operations/contract";
import type {
  RecurringCommand,
  RecurringDocument,
  RecurringSchedule,
} from "../../src/core/recurring-plans/contract";
import type { QueryCaller } from "../canonical-work/contract";
import { Data } from "effect";

export class RecurringPlanningUnavailable extends Data.TaggedError(
  "RecurringPlanningUnavailable"
) {}
export type RecurringOperation =
  | "recurringPlans.getRecurringWorkspace"
  | "recurringPlans.applyRecurringEdit";

export type RecurringEditWork = Readonly<{
  work: CanonicalPreparationWork;
  command: RecurringCommand;
  compact: boolean;
}>;
export type RecurringAuditWork = Readonly<{
  db: D1Database;
  subject: QueryCaller;
  current: number;
}>;

/** A bounded calculation selection and the separate complete compact editing projection. */
export type RecurringReadProjection = Readonly<{
  months: ReadonlyArray<string>;
  schedule: RecurringSchedule;
  editing: RecurringDocument;
}>;
