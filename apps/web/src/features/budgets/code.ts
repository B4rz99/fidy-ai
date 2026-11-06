/** Prepare the screen without reading a Budget or making an access decision. */
export const preloadBudgetScreen = (): Promise<void> => import("./screen").then(() => undefined);
