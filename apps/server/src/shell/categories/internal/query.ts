import { Option, Schema } from "effect";
import { Category } from "~/core/categories/contract";
import type { ListCategoriesResponse } from "~/shell/categories/contract";

const maximumCategoryCount = 100;

const decodeCategoryRows = Schema.decodeUnknownOption(Schema.Array(Category));

export const categoryResponseFromRows = (
  rows: unknown
): Option.Option<typeof ListCategoriesResponse.Type> => {
  const categories = decodeCategoryRows(rows);

  return Option.flatMap(categories, (decoded) =>
    decoded.length <= maximumCategoryCount
      ? Option.some({ data: decoded, next: [] as const })
      : Option.none()
  );
};
