import { expect, it } from "@effect/vitest";
import { normalizeSearchText } from "./operations";

it("normalizes user-visible text without case or diacritic distinctions", () => {
  expect(normalizeSearchText("ÉXITO Bogotá")).toBe("exito bogota");
});
