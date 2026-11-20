import { Schema } from "effect";
import { NormalizedSearchText } from "./contract";

const normalize = Schema.decodeSync(NormalizedSearchText);

export const normalizeSearchText = (value: string): string => normalize(value);
