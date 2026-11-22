import * as localDashboard from "./internal/sqlite-dashboard";

export const isLocalDashboardOperation: typeof localDashboard.isLocalDashboardOperation = (id) =>
  localDashboard.isLocalDashboardOperation(id);

export const dispatchLocalDashboard: typeof localDashboard.dispatchLocalDashboard = (unit) =>
  localDashboard.dispatchLocalDashboard(unit);

export const prepareLocalDashboard: typeof localDashboard.prepareLocalDashboard = (user, edit) =>
  localDashboard.prepareLocalDashboard(user, edit);

export const readLocalDashboard: typeof localDashboard.readDashboard = (...args) =>
  localDashboard.readDashboard(...args);
