const normalizedSearchSql = (expression: string): string =>
  `lower(regexp_replace(normalize(${expression}, NFD), '[̀-ͯ]', '', 'g'))`;

/** Immutable SQL expression shared by the Dashboard query and its expression index. */
export const normalizedTransactionSearchSql = normalizedSearchSql(
  "coalesce(counterparty, '') || ' ' || coalesce(notes, '')"
);
