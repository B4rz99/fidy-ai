export const preloadBudgetScreen = (): Promise<void> =>
  Promise.all([
    import("./workspace").then((module) => module.BudgetWorkspace.preloadInteractions()),
    import("./screen"),
    import("./editor"),
  ]).then(() => undefined);
