import type { CanonicalPreparationWork } from "../canonical-operations/contract";
import type { RecurringCommand } from "../../src/core/recurring-plans/contract";
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
}>;
export type RecurringAuditWork = Readonly<{
  db: D1Database;
  subject: QueryCaller;
  current: number;
}>;
