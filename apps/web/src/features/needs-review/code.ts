export const preloadReviewWorkspaceCode = (): Promise<void> =>
  import("./workspace").then(() => undefined);
