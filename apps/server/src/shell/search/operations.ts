/** Builds a contains pattern for a SQL `LIKE ... ESCAPE '\\'` query from normalized search text. */
export const searchLikePattern = (search: string): string =>
  `%${search.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
