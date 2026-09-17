/** Case- and diacritic-insensitive normalization for user-visible search text. */
export const normalizeSearchText = (value: string): string =>
  value
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-CO");
