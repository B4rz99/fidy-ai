import { Schema } from "effect";
import { NormalizedSearchText } from "./contract";

const normalize = Schema.decodeSync(NormalizedSearchText);

/** Case- and diacritic-insensitive normalization for user-visible search text. */
export const normalizeSearchText = (value: string): string => normalize(value);
