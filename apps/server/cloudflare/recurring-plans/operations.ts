import * as sqlitePlans from "./internal/sqlite-plans";

export const dispatchLocalRecurringPlans: typeof sqlitePlans.dispatchLocalRecurringPlans = (unit) =>
  sqlitePlans.dispatchLocalRecurringPlans(unit);

export const isLocalRecurringPlan: typeof sqlitePlans.isLocalRecurringPlan = (id) =>
  sqlitePlans.isLocalRecurringPlan(id);

export const editLocalRecurringPlan: typeof sqlitePlans.editLocalRecurringPlan = (
  command,
  user,
  current
) => sqlitePlans.editLocalRecurringPlan(command, user, current);

export const prepareLocalRecurringEdit: typeof sqlitePlans.prepareLocalRecurringEdit = (
  command,
  user,
  current
) => sqlitePlans.prepareLocalRecurringEdit(command, user, current);

export const readLocalRecurringWorkspace: typeof sqlitePlans.workspace = (...args) =>
  sqlitePlans.workspace(...args);
