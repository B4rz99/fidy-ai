import { describe, expect, it } from "vitest";
import { responsiveSplitClass } from "./presentation";

describe("Dashboard responsive projection", () => {
  it("keeps mobile column order while applying canonical desktop axes", () => {
    expect(responsiveSplitClass("row")).toBe("flex-col md:flex-row");
    expect(responsiveSplitClass("column")).toBe("flex-col");
  });
});
