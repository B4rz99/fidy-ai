import type { Effect } from "effect";
import type { CategoriesUnavailable } from "./contract";
import { verifyStorage } from "./internal/projection";

/** Verify Category storage is installed for release smoke without loading any retained content. */
export const verifyCategoryStorage = (
  input: Readonly<{ db: D1Database }>
): Effect.Effect<void, CategoriesUnavailable> => verifyStorage(input);
