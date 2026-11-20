/** Prepare presentation code without constructing a query or initializing a Dashboard. */
export const preloadDashboardView = (): Promise<void> =>
  Promise.all([
    import("./view").then((module) => module.DashboardViewComponent.preloadInteractions()),
    import("./drag-adapter"),
  ]).then(() => undefined);
