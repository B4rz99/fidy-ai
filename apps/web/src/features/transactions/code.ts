/** Prepare the list's code without creating a client, query or access decision. */
export const preloadTransactionList = (): Promise<void> =>
  Promise.all([import("./list-feature"), import("./workspace")]).then(() => undefined);
