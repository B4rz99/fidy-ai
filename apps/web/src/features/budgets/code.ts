/** Prepare the screen without reading a Budget or making an access decision. */
export const preloadBudgetScreen = (): Promise<void> =>
  Promise.all([
    import("./workspace").then((module) => module.BudgetWorkspace.preloadInteractions()),
    import("./screen"),
    import("./editor"),
  ]).then(() => undefined);
