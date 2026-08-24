import { describe, expect, it } from "vitest";
import { responsiveSplitClass, weightedChildStyle } from "./presentation";

describe("Dashboard responsive projection", () => {
  it("keeps mobile column order while applying canonical desktop axes", () => {
    expect(responsiveSplitClass("row")).toBe("flex-col md:flex-row");
    expect(responsiveSplitClass("column")).toBe("flex-col");
  });

  it("publishes canonical weight as a desktop-only CSS input", () => {
    expect(weightedChildStyle(2)).toEqual({ "--dashboard-weight": 2 });
  });
});
