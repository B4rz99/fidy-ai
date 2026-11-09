export const preloadRecurringScreen = (): Promise<void> =>
  Promise.all([
    import("./workspace").then((module) => module.RecurringWorkspace.preloadInteractions()),
    import("./feature"),
    import("./create-plan"),
    import("./details"),
    import("./plan-form"),
    import("./lifecycle"),
    import("./transaction-link"),
    import("./creation-result"),
  ]).then(() => undefined);
