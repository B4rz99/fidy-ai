/** Prepare presentation code without constructing a query or initializing a Dashboard. */
export const preloadDashboardView = (): Promise<void> =>
  Promise.all([
    import("./view").then((module) =>
      Promise.all([
        module.DashboardViewComponent.preloadInteractions(),
        module.DashboardViewComponent.preloadPresentation(),
      ])
    ),
    import("./spending-chart"),
    import("./drag-adapter"),
  ]).then(() => undefined);
