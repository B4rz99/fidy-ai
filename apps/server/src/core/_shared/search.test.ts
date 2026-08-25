import { expect, it } from "@effect/vitest";
import { searchLikePattern } from "./search";

it("wraps search text for a contains match and escapes PostgreSQL LIKE metacharacters", () => {
  expect(searchLikePattern(String.raw`a\b%c_d`)).toBe(String.raw`%a\\b\%c\_d%`);
});
