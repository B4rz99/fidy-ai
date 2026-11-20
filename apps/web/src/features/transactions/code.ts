export const preloadTransactionList = (): Promise<void> =>
  Promise.all([
    import("./list-feature"),
    import("./workspace").then((module) => module.TransactionWorkspace.preloadInteractions()),
    import("./capture"),
    import("./detail"),
    import("./bulk-correction"),
  ]).then(() => undefined);
