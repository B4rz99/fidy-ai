/** Case- and diacritic-insensitive normalization for user-visible search text. */
export const normalizeSearchText = (value: string): string =>
  value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-CO");

/** Escapes normalized text for a contains match using PostgreSQL `LIKE ... ESCAPE '\\'`. */
export const searchLikePattern = (search: string): string =>
  `%${search.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
