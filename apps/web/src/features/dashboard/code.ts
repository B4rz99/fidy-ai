/** Prepare presentation code without constructing a query or initializing a Dashboard. */
export const preloadDashboardView = (): Promise<void> => import("./view").then(() => undefined);
