export type SharedBindings = Partial<
  Readonly<
    Record<
      "USER_STORE" | "DIRECTORY" | "PRICING" | "MAINTENANCE" | "ERASURE",
      {
        getByName(name: string): Pick<Fetcher, "fetch">;
      }
    >
  >
>;
