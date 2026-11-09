/** Prepare the workspace without fetching original material or constructing a query. */
export const preloadReviewWorkspaceCode = (): Promise<void> =>
  import("./workspace").then(() => undefined);
