import { expect, it } from "@effect/vitest";
import { searchLikePattern } from "./operations";

it("wraps search text for a contains match and escapes SQL LIKE metacharacters", () => {
  expect(searchLikePattern(String.raw`a\b%c_d`)).toBe(String.raw`%a\\b\%c\_d%`);
});
