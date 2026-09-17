/** Builds a contains pattern for PostgreSQL `LIKE ... ESCAPE '\\'` from normalized search text. */
export const searchLikePattern = (search: string): string =>
  `%${search.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
